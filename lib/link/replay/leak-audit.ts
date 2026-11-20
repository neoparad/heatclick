/**
 * UGOKI LINK v2 — Post-Decryption / Post-Decompression Zero-Leak Canary Gate (`surf.replay_zero_leak`)
 *
 * Implements §11.11 item 8 mandatory release gate:
 *   Plants unique canary tokens across:
 *     1. Page text
 *     2. Form inputs, passwords, payment fields
 *     3. DOM attributes (data-*, aria-label, title, alt, data-ugk-sensitive)
 *     4. URLs (href, src, query params)
 *     5. Inline CSS styles (url(), content, custom properties)
 *     6. Input-reactive dynamic DOM changes
 *   Runs full pipeline: Mask -> Serialize -> Gzip -> AES-256-GCM Encrypt -> Decrypt -> Gunzip -> Decode
 *   and asserts ZERO recoverable canary tokens in BOTH:
 *     - Default mask-all mode (all 6 surfaces must have 0 leaks)
 *     - Partial allowlist mode (everything outside allowlist + inputs/passwords/payments/sensitive
 *       fields inside allowlist must have 0 leaks)
 */

import crypto from 'node:crypto';
import { getGate } from '@/packages/contract/ledgers';
import {
  DEFAULT_MASK_ALL_CONFIG,
  maskReplayDomTree,
  type MaskAllowlistConfig,
  type RawReplayDomNode,
} from './masker';
import { decryptReplayPayload, encryptReplayPayload } from './store';

export interface CanaryAuditReport {
  readonly gateId: 'surf.replay_zero_leak';
  readonly legacyAlias: 'sur.replay_zero_leak';
  readonly ledgerRegistered: boolean;
  readonly defaultModeLeakedCanaries: ReadonlyArray<string>;
  readonly allowlistModeLeakedCanaries: ReadonlyArray<string>;
  readonly allowlistedSafeTextPreserved: boolean;
  readonly totalLeaks: number;
  readonly passed: boolean;
}

function buildCanaryDomFixture(): {
  readonly root: RawReplayDomNode;
  readonly mustNeverLeakDefault: ReadonlyArray<string>;
  readonly mustNeverLeakAllowlist: ReadonlyArray<string>;
  readonly allowlistedStaticCopy: string;
} {
  const cText = 'CANARY_BODY_TEXT_7719A';
  const cInput = 'CANARY_USER_INPUT_8821B';
  const cPassword = 'CANARY_PASSWORD_9932C';
  const cPayment = 'CANARY_CARD_4111_5543D';
  const cAttr = 'CANARY_ATTR_EMAIL_6654E';
  const cUrl = 'CANARY_URL_SECRET_TOKEN_1122F';
  const cStyle = 'CANARY_INLINE_STYLE_3344G';
  const cReactive = 'CANARY_REACTIVE_ECHO_5566H';
  const cSensitiveInAllowed = 'CANARY_SENSITIVE_IN_ALLOWED_7788I';
  const allowlistedStaticCopy = 'Public Approved Marketing Heading';

  const root: RawReplayDomNode = {
    nodeId: 'root',
    kind: 'element',
    tagName: 'main',
    rect: { x: 0, y: 0, width: 1280, height: 900 },
    inlineStyle: `display:block; background-image: url("https://evil.example/${cStyle}"); --secret-token: "${cStyle}"`,
    attributes: {
      'data-user-email': cAttr,
      'aria-label': `Profile ${cAttr}`,
      title: cAttr,
      href: `https://example.jp/account?token=${cUrl}`,
    },
    children: [
      // Outside allowlist: normal text
      {
        nodeId: 'n_text',
        kind: 'text',
        tagName: '#text',
        rect: { x: 10, y: 10, width: 200, height: 20 },
        textContent: `Private account statement ${cText}`,
      },
      // Outside allowlist: link + image with canary URL & alt
      {
        nodeId: 'n_media',
        kind: 'media',
        tagName: 'img',
        rect: { x: 10, y: 40, width: 120, height: 80 },
        attributes: { src: `https://cdn.example.jp/img?secret=${cUrl}`, alt: cAttr },
      },
      // Approved allowlist section containing safe copy PLUS hard-floor inputs/passwords/payment/sensitive/reactive nodes!
      {
        nodeId: 'n_allowed_section',
        kind: 'element',
        tagName: 'section',
        allowlistKey: 'hero_copy_approved',
        rect: { x: 0, y: 120, width: 1280, height: 400 },
        children: [
          {
            nodeId: 'n_safe_heading',
            kind: 'text',
            tagName: '#text',
            rect: { x: 20, y: 140, width: 300, height: 32 },
            textContent: allowlistedStaticCopy,
          },
          {
            nodeId: 'n_input_inside_allowed',
            kind: 'input',
            tagName: 'input',
            inputType: 'text',
            inputValue: cInput,
            textContent: cInput,
            rect: { x: 20, y: 180, width: 240, height: 36 },
            attributes: { value: cInput, placeholder: cInput },
          },
          {
            nodeId: 'n_password_inside_allowed',
            kind: 'input',
            tagName: 'input',
            inputType: 'password',
            inputValue: cPassword,
            textContent: cPassword,
            rect: { x: 20, y: 220, width: 240, height: 36 },
            attributes: { type: 'password', name: 'password', value: cPassword },
          },
          {
            nodeId: 'n_payment_inside_allowed',
            kind: 'input',
            tagName: 'input',
            inputType: 'text',
            inputValue: cPayment,
            textContent: cPayment,
            rect: { x: 20, y: 260, width: 240, height: 36 },
            attributes: { name: 'cc-number', autocomplete: 'cc-number', value: cPayment },
          },
          {
            nodeId: 'n_sensitive_span_inside_allowed',
            kind: 'element',
            tagName: 'span',
            rect: { x: 20, y: 300, width: 240, height: 24 },
            attributes: { 'data-ugk-sensitive': 'true' },
            textContent: cSensitiveInAllowed,
          },
          {
            nodeId: 'n_reactive_inside_allowed',
            kind: 'element',
            tagName: 'div',
            inputReactive: true,
            rect: { x: 20, y: 340, width: 240, height: 24 },
            textContent: `Live preview: ${cReactive}`,
          },
        ],
      },
      // Unreproducible regions
      {
        nodeId: 'n_canvas',
        kind: 'canvas',
        tagName: 'canvas',
        rect: { x: 10, y: 550, width: 300, height: 150 },
        textContent: cText,
      },
      {
        nodeId: 'n_iframe',
        kind: 'cross_origin_iframe',
        tagName: 'iframe',
        rect: { x: 320, y: 550, width: 300, height: 150 },
        attributes: { src: `https://merchant.example.com/pay?card=${cPayment}` },
      },
      {
        nodeId: 'n_closed_shadow',
        kind: 'closed_shadow_dom',
        tagName: 'div',
        rect: { x: 640, y: 550, width: 200, height: 100 },
        textContent: cPassword,
      },
    ],
  };

  const sharedHardCanaries = [
    cText,
    cInput,
    cPassword,
    cPayment,
    cAttr,
    cUrl,
    cStyle,
    cReactive,
    cSensitiveInAllowed,
  ];

  return {
    root,
    mustNeverLeakDefault: [...sharedHardCanaries, allowlistedStaticCopy],
    mustNeverLeakAllowlist: sharedHardCanaries,
    allowlistedStaticCopy,
  };
}

function scanDecodedPayloadForCanaries(
  rawDecodedText: string,
  canaries: ReadonlyArray<string>
): ReadonlyArray<string> {
  const leaks: string[] = [];
  for (const token of canaries) {
    if (rawDecodedText.includes(token)) {
      leaks.push(token);
      continue;
    }
    // Also check URL-encoded and base64-encoded variants so no encoding hides a leak
    if (rawDecodedText.includes(encodeURIComponent(token))) {
      leaks.push(`${token}(urlencoded)`);
      continue;
    }
    const b64 = Buffer.from(token, 'utf8').toString('base64').replace(/=+$/, '');
    if (rawDecodedText.includes(b64)) {
      leaks.push(`${token}(base64)`);
    }
  }
  return leaks;
}

/**
 * Executes the full end-to-end zero-leak canary gate (`surf.replay_zero_leak`)
 * across both default mask-all and partial-allowlist configurations after full
 * gzip compression, AES-256-GCM encryption, decryption, decompression, and decoding.
 */
export function runReplayZeroLeakCanaryGate(): CanaryAuditReport {
  const fixture = buildCanaryDomFixture();
  const key = crypto.randomBytes(32);

  // 1. Default mask-all mode
  const maskedDefault = maskReplayDomTree(fixture.root, DEFAULT_MASK_ALL_CONFIG);
  const encDefault = encryptReplayPayload(maskedDefault, key, 'k_audit_v1');
  const decDefault = decryptReplayPayload(encDefault, key);
  const defaultLeaks = scanDecodedPayloadForCanaries(
    decDefault.rawDecodedText,
    fixture.mustNeverLeakDefault
  );

  // 2. Partial allowlist mode
  const allowConfig: MaskAllowlistConfig = {
    maskConfigVersion: 'mask-allow-v2',
    approvalId: 'apr_admin_001',
    allowedKeys: ['hero_copy_approved'],
  };
  const maskedAllow = maskReplayDomTree(fixture.root, allowConfig);
  const encAllow = encryptReplayPayload(maskedAllow, key, 'k_audit_v1');
  const decAllow = decryptReplayPayload(encAllow, key);
  const allowLeaks = scanDecodedPayloadForCanaries(
    decAllow.rawDecodedText,
    fixture.mustNeverLeakAllowlist
  );
  const allowlistedSafeTextPreserved = decAllow.rawDecodedText.includes(fixture.allowlistedStaticCopy);

  const totalLeaks = defaultLeaks.length + allowLeaks.length;
  return {
    gateId: 'surf.replay_zero_leak',
    legacyAlias: 'sur.replay_zero_leak',
    ledgerRegistered: Boolean(getGate('surf.replay_zero_leak')),
    defaultModeLeakedCanaries: defaultLeaks,
    allowlistModeLeakedCanaries: allowLeaks,
    allowlistedSafeTextPreserved,
    totalLeaks,
    passed: totalLeaks === 0 && allowlistedSafeTextPreserved,
  };
}
