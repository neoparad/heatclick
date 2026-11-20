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
    if (
      spec.destinationUrl &&
      ctx.registeredDestinationUrls &&
      !ctx.registeredDestinationUrls.includes(spec.destinationUrl)
    ) {
      violations.push(`A1 destination URL "${spec.destinationUrl}" is not in registered link table`);
    }
  }

  if (spec.tier === 'A2') {
    const protectedSet = new Set(ctx.protectedMatchKeys);
    for (const op of spec.operations) {
      if (protectedSet.has(op.targetMatchKey)) {
        violations.push(`A2_PROTECTED_REGION_FORBIDDEN: target "${op.targetMatchKey}" is protected`);
      }
      if (!op.inverseOp || !op.inverseOp.kind) {
        violations.push(`A2 operation "${op.opId}" must store an explicit inverse operation`);
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
