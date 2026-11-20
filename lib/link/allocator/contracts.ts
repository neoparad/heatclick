/**
 * UGOKI LINK v2 — 3-Tier Conversion & Metric Contract (`site_rule ⊂ label ⊂ metric`)
 *
 * Implements D-18, TEL M10, ML M1, EV M3:
 *   Tier 1: Site Conversion Rule (`cv_key@rule_ver`, <= 50 per site)
 *   Tier 2: Label Contract (`label_key@contract_version`, initial labels:
 *           `engaged_view | aff_click | lead | purchase` + Revenue Grain Ladder)
 *   Tier 3: Metric Definition (`metric_definition_id@version`, locked at experiment start,
 *           hierarchy `ev.L0 | ev.L1 | ev.L2 | ev.L3`)
 */

import {
  REVENUE_GRAINS,
  canonicalJsonStringify,
  sha256Hex,
  type RevenueGrain,
} from '../../../packages/contract/schema';
import type { UnitKind } from '../../../packages/contract/schema';

export const MAX_SITE_CONVERSION_RULES = 50 as const;

export const CANONICAL_LABEL_KEYS = [
  'engaged_view',
  'aff_click',
  'lead',
  'purchase',
] as const;
export type CanonicalLabelKey = (typeof CANONICAL_LABEL_KEYS)[number];

export const METRIC_LEVELS = ['ev.L0', 'ev.L1', 'ev.L2', 'ev.L3'] as const;
export type MetricLevel = (typeof METRIC_LEVELS)[number];

export interface SiteConversionRule {
  readonly site_id: string;
  readonly cv_key: string;
  readonly rule_ver: number;
  readonly predicate_kind: 'id' | 'class' | 'selector' | 'text' | 'href' | 'el_fp_set';
  readonly predicate_value: string;
  readonly activation_kinds: readonly ('click' | 'auxclick' | 'keyboard' | 'new_tab_inferred' | 'tel_link' | 'mailto_link')[];
  readonly retro_evaluable_in_lab: boolean;
}

export interface LabelContract {
  readonly label_key: CanonicalLabelKey;
  readonly contract_version: number;
  readonly site_rule_refs: readonly string[]; // `<cv_key>@<rule_ver>`
  readonly value_grain: RevenueGrain;
  readonly not_slot_metric: boolean;
  readonly not_training_label: boolean;
  readonly requires_click_reconciliation_gate: 'join.G13' | null;
}

export interface MetricDefinition {
  readonly metric_definition_id: string;
  readonly version: number;
  readonly level: MetricLevel;
  readonly label_ref: string; // `<label_key>@<contract_version>`
  readonly unit_kind: UnitKind;
  readonly window_days: number;
  readonly aggregation: 'rate_per_unit' | 'sum_per_unit' | 'mean_per_unit' | 'quantile';
  readonly locked_at: string | null; // ISO UTC when locked at experiment start
  readonly content_hash: string;
}

export interface MetricContractValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export function formatSiteRuleRef(rule: Pick<SiteConversionRule, 'cv_key' | 'rule_ver'>): string {
  return `${rule.cv_key}@${rule.rule_ver}`;
}

export function formatLabelRef(label: Pick<LabelContract, 'label_key' | 'contract_version'>): string {
  return `${label.label_key}@${label.contract_version}`;
}

export function computeMetricDefinitionHash(
  def: Omit<MetricDefinition, 'content_hash'>
): string {
  return sha256Hex(canonicalJsonStringify(def));
}

export function createLockedMetricDefinition(
  def: Omit<MetricDefinition, 'content_hash' | 'locked_at'>,
  lockedAtIso: string
): MetricDefinition {
  const withoutHash: Omit<MetricDefinition, 'content_hash'> = {
    ...def,
    locked_at: lockedAtIso,
  };
  return {
    ...withoutHash,
    content_hash: computeMetricDefinitionHash(withoutHash),
  };
}

/**
 * Validates strict containment `site_rule ⊂ label_contract ⊂ metric_definition`
 * and D-18 revenue-grain / training-label safety invariants.
 */
export function validateMetricContractHierarchy(params: {
  readonly siteRules: readonly SiteConversionRule[];
  readonly labelContract: LabelContract;
  readonly metricDefinition: MetricDefinition;
}): MetricContractValidationResult {
  const errors: string[] = [];
  const { siteRules, labelContract, metricDefinition } = params;

  // 1. Site conversion rule cap <= 50 per site (TEL M10 / §4.10)
  if (siteRules.length > MAX_SITE_CONVERSION_RULES) {
    errors.push(
      `Site has ${siteRules.length} conversion rules, exceeding maximum ${MAX_SITE_CONVERSION_RULES}`
    );
  }

  const ruleRefSet = new Set<string>();
  for (const r of siteRules) {
    const ref = formatSiteRuleRef(r);
    if (ruleRefSet.has(ref)) {
      errors.push(`Duplicate site conversion rule ref "${ref}"`);
    }
    ruleRefSet.add(ref);
  }

  // 2. Containment: every site_rule_ref in labelContract MUST exist in siteRules (except engaged_view which is dwell-derived)
  if (labelContract.label_key !== 'engaged_view' && labelContract.site_rule_refs.length === 0) {
    errors.push(
      `LabelContract "${formatLabelRef(labelContract)}" must reference at least one site conversion rule`
    );
  }
  for (const ref of labelContract.site_rule_refs) {
    if (!ruleRefSet.has(ref)) {
      errors.push(
        `LabelContract "${formatLabelRef(labelContract)}" references unknown site rule "${ref}" (containment violation: site_rule ⊂ label)`
      );
    }
  }

  // 3. Revenue-grain ladder invariants (D-18)
  if (!REVENUE_GRAINS.includes(labelContract.value_grain)) {
    errors.push(`Invalid value_grain "${String(labelContract.value_grain)}"`);
  }
  if (labelContract.value_grain === 'program_split') {
    if (!labelContract.not_slot_metric || !labelContract.not_training_label) {
      errors.push(
        'D-18 invariant: value_grain="program_split" MUST set not_slot_metric=true and not_training_label=true'
      );
    }
  }

  // 4. Containment: metricDefinition MUST reference the exact labelContract
  const expectedLabelRef = formatLabelRef(labelContract);
  if (metricDefinition.label_ref !== expectedLabelRef) {
    errors.push(
      `MetricDefinition "${metricDefinition.metric_definition_id}" label_ref "${metricDefinition.label_ref}" does not match "${expectedLabelRef}" (containment violation: label ⊂ metric)`
    );
  }

  // 5. L3 revenue metric cannot use value_grain === 'none' or 'program_split' as primary slot metric
  if (metricDefinition.level === 'ev.L3') {
    if (labelContract.value_grain === 'none') {
      errors.push('ev.L3 revenue metric cannot use value_grain="none"');
    }
    if (labelContract.requires_click_reconciliation_gate !== 'join.G13') {
      errors.push('ev.L3 revenue metric must declare click reconciliation gate "join.G13" (EV G-4)');
    }
  }

  // 6. Content hash integrity
  const { content_hash, ...rest } = metricDefinition;
  const recomputed = computeMetricDefinitionHash(rest);
  if (content_hash !== recomputed) {
    errors.push(
      `MetricDefinition "${metricDefinition.metric_definition_id}" content_hash mismatch (tampered definition)`
    );
  }

  return { valid: errors.length === 0, errors };
}
