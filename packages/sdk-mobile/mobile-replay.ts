/**
 * UGOKI LINK v2 — Mobile Visual Replay Masking & Independent Per-OS Release Gates (§11.11 items 5 & 8)
 *
 * Shares the exact masking, consent, encryption, and deletion invariants of Bundle 7-B (`lib/link/replay`),
 * while enforcing mobile-specific rules:
 *   - Standard native controls (UILabel/TextView, UITextField/EditText, SecureField/Password, Payment, Image)
 *     follow default mask-all + unbreakable hard floor on inputs/passwords/payments/sensitive widgets
 *   - Custom-drawn surfaces (`custom_canvas`, `custom_metal_skia`, `custom_opengl`, `webview`)
 *     are ALWAYS rendered as bounding boxes ONLY (pixel/text contents NEVER captured)
 *   - Each OS (`ios`, `android`, `react_native`, `flutter`) is gated independently without waiting for Web
 */

import crypto from 'node:crypto';
import {
  DEFAULT_MASK_ALL_CONFIG,
  decryptReplayPayload,
  encryptReplayPayload,
  maskReplayDomTree,
  type MaskAllowlistConfig,
  type MaskedReplaySnapshot,
  type RawReplayDomNode,
} from '@/lib/link/replay';
import type { MobileOsGateResult, MobilePlatform, RawMobileViewNode } from './types';

function mobileViewToReplayDomNode(node: RawMobileViewNode): RawReplayDomNode {
  const attrs: Record<string, string> = {};
  if (node.sensitiveFlag) {
    attrs['data-ugk-sensitive'] = 'true';
  }

  switch (node.widgetKind) {
    case 'custom_canvas':
    case 'custom_metal_skia':
    case 'custom_opengl':
      return {
        nodeId: node.viewId,
        kind: 'canvas',
        tagName: 'canvas',
        rect: node.bounds,
        textContent: node.text, // dropped by box-only masker
        attributes: attrs,
      };
    case 'webview':
      return {
        nodeId: node.viewId,
        kind: 'cross_origin_iframe',
        tagName: 'iframe',
        rect: node.bounds,
        textContent: node.text,
        attributes: attrs,
      };
    case 'standard_image':
      return {
        nodeId: node.viewId,
        kind: 'media',
        tagName: 'img',
        rect: node.bounds,
        attributes: attrs,
      };
    case 'standard_password':
      return {
        nodeId: node.viewId,
        kind: 'input',
        tagName: 'input',
        inputType: 'password',
        inputValue: node.inputValue,
        textContent: node.text,
        rect: node.bounds,
        attributes: { ...attrs, type: 'password', name: 'password' },
      };
    case 'standard_payment':
      return {
        nodeId: node.viewId,
        kind: 'input',
        tagName: 'input',
        inputType: 'text',
        inputValue: node.inputValue,
        textContent: node.text,
        rect: node.bounds,
        attributes: { ...attrs, name: 'cc-number', autocomplete: 'cc-number' },
      };
    case 'standard_input':
      return {
        nodeId: node.viewId,
        kind: 'input',
        tagName: 'input',
        inputType: 'text',
        inputValue: node.inputValue,
        textContent: node.text,
        rect: node.bounds,
        attributes: attrs,
      };
    case 'standard_text':
      return {
        nodeId: node.viewId,
        kind: 'element',
        tagName: 'div',
        allowlistKey: node.allowlistKey,
        rect: node.bounds,
        textContent: node.text,
        attributes: attrs,
        children: (node.children ?? []).map(mobileViewToReplayDomNode),
      };
  }
}

export function maskMobileViewHierarchy(
  root: RawMobileViewNode,
  config: MaskAllowlistConfig = DEFAULT_MASK_ALL_CONFIG
): MaskedReplaySnapshot {
  return maskReplayDomTree(mobileViewToReplayDomNode(root), config);
}

/**
 * Evaluates independent OS-level release gates for a mobile platform (consent, masking zero-leak
 * on standard & custom-drawn widgets after gzip + AES-256-GCM decrypt/decompress, revocation wipe,
 * deletion plan registration, and weight budget).
 */
export function evaluateMobileOsReplayGate(params: {
  readonly platform: MobilePlatform;
  readonly revocationZeroSendWipePassed: boolean;
  readonly consentGatePassed: boolean;
  readonly deletionPlanRegistered: boolean;
  readonly estimatedSdkBundleKb: number;
  readonly maxSdkBundleKb?: number;
}): MobileOsGateResult {
  const details: string[] = [];
  const maxKb = params.maxSdkBundleKb ?? 120;

  const cText = `MOB_${params.platform.toUpperCase()}_CANARY_TEXT_01`;
  const cInput = `MOB_${params.platform.toUpperCase()}_CANARY_INPUT_02`;
  const cPass = `MOB_${params.platform.toUpperCase()}_CANARY_PASS_03`;
  const cCard = `MOB_${params.platform.toUpperCase()}_CANARY_CARD_04`;
  const cCustom = `MOB_${params.platform.toUpperCase()}_CANARY_SKIA_05`;
  const cWebview = `MOB_${params.platform.toUpperCase()}_CANARY_WEBVIEW_06`;

  const fixture: RawMobileViewNode = {
    viewId: 'screen_root',
    widgetKind: 'standard_text',
    nativeClassName: 'RootContainer',
    bounds: { x: 0, y: 0, width: 390, height: 844 },
    text: cText,
    children: [
      {
        viewId: 'txt_input',
        widgetKind: 'standard_input',
        nativeClassName: 'TextInput',
        bounds: { x: 16, y: 80, width: 358, height: 44 },
        inputValue: cInput,
        text: cInput,
      },
      {
        viewId: 'pwd_input',
        widgetKind: 'standard_password',
        nativeClassName: 'SecureTextField',
        bounds: { x: 16, y: 140, width: 358, height: 44 },
        inputValue: cPass,
        text: cPass,
      },
      {
        viewId: 'pay_input',
        widgetKind: 'standard_payment',
        nativeClassName: 'CardInput',
        bounds: { x: 16, y: 200, width: 358, height: 44 },
        inputValue: cCard,
        text: cCard,
      },
      {
        viewId: 'skia_chart',
        widgetKind: 'custom_metal_skia',
        nativeClassName: 'CustomPaintCanvas',
        bounds: { x: 16, y: 260, width: 358, height: 200 },
        text: cCustom,
      },
      {
        viewId: 'embedded_wv',
        widgetKind: 'webview',
        nativeClassName: 'WKWebView',
        bounds: { x: 16, y: 480, width: 358, height: 220 },
        text: cWebview,
      },
    ],
  };

  const masked = maskMobileViewHierarchy(fixture, DEFAULT_MASK_ALL_CONFIG);
  const key = crypto.randomBytes(32);
  const enc = encryptReplayPayload(masked, key, `mob_${params.platform}_k1`);
  const dec = decryptReplayPayload(enc, key);

  const canaries = [cText, cInput, cPass, cCard, cCustom, cWebview];
  const leaked = canaries.filter((token) => dec.rawDecodedText.includes(token));
  const maskingZeroLeakPassed = leaked.length === 0;
  if (!maskingZeroLeakPassed) {
    details.push(`Leaked canaries on ${params.platform}: ${leaked.join(', ')}`);
  }

  const hasCanvasBox = masked.unreproducibleRegions.some((r) => r.kind === 'canvas');
  const hasWebviewBox = masked.unreproducibleRegions.some((r) => r.kind === 'cross_origin_iframe');
  const customDrawnBoxOnlyPassed = hasCanvasBox && hasWebviewBox;
  if (!customDrawnBoxOnlyPassed) {
    details.push(`Custom-drawn / WebView unreproducible bounding box disclosure incomplete on ${params.platform}`);
  }

  const weightBudgetWithinCap = params.estimatedSdkBundleKb <= maxKb;
  if (!weightBudgetWithinCap) {
    details.push(`Estimated bundle ${params.estimatedSdkBundleKb} KB exceeds cap ${maxKb} KB`);
  }

  const passed =
    params.consentGatePassed &&
    maskingZeroLeakPassed &&
    customDrawnBoxOnlyPassed &&
    params.revocationZeroSendWipePassed &&
    params.deletionPlanRegistered &&
    weightBudgetWithinCap;

  return {
    platform: params.platform,
    independentOfWebGate: true,
    consentGatePassed: params.consentGatePassed,
    maskingZeroLeakPassed,
    customDrawnBoxOnlyPassed,
    revocationZeroSendWipePassed: params.revocationZeroSendWipePassed,
    deletionPlanRegistered: params.deletionPlanRegistered,
    weightBudgetWithinCap,
    passed,
    details,
  };
}
