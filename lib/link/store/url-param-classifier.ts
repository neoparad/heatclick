/**
 * UGOKI LINK v2 — URL Parameter 59-Pair Agreeing Probe Classifier (§6.4 / join.G11)
 *
 * Classifies query parameters into:
 * - `user_input`: GET-form or on-site search parameters (always masked to length bucket)
 * - `content`: parameters where >=1 paired fetch differs on redirect target, canonical,
 *   skeleton, head, body, product ID, price signature, or outbound/internal links
 * - `noise`: parameters with >= 59 (`join.param_noise_min_pairs`) valid agreeing probe pairs
 *   and 0 disagreements (Rule of 3: 0.95^59 = 0.0485 < 0.05)
 * - `unknown`: insufficient agreeing pairs (<59) and 0 disagreements; marks `key_degraded = true`
 *   and triggers coarse `(url_id, head_fp)` secondary bucketing until promoted
 */

import { getConstant } from '../../../packages/contract/ledgers';
import {
  DEFAULT_NOISE_EXACT_PARAMS,
  type ParamClass,
  type UrlKeyV2Rules,
} from '../../../packages/contract/urlkey';

export type StoredParamClassification = 'content' | 'noise' | 'user_input' | 'unknown';

export type ProbeDiffDimension =
  | 'http_status'
  | 'redirect_target'
  | 'canonical_url'
  | 'skel_fp'
  | 'head_fp'
  | 'body_fp'
  | 'product_id'
  | 'price_signature'
  | 'links_fp';

export interface PageProbeSnapshot {
  readonly httpStatus: number;
  readonly finalUrl: string;
  readonly canonicalUrl: string | null;
  readonly skelFp: string;
  readonly headFp: string;
  readonly bodyFp: string;
  readonly productId: string | null;
  readonly priceSignature: string | null;
  readonly linksFp: string;
}

export interface ParamProbePair {
  readonly pairId: string;
  readonly baseUrl: string;
  readonly paramName: string;
  readonly sampleParamValueLength: number;
  readonly withParam: PageProbeSnapshot;
  readonly withoutParam: PageProbeSnapshot;
  readonly probedAtMs: number;
}

export interface ProbePairComparison {
  readonly pairId: string;
  readonly baseUrl: string;
  readonly validResponse: boolean;
  readonly identical: boolean;
  readonly diffs: readonly ProbeDiffDimension[];
}

export interface ParamClassificationInput {
  readonly paramName: string;
  readonly pairs: readonly ParamProbePair[];
  readonly userInputInventory?: ReadonlySet<string> | readonly string[];
  readonly minAgreeingPairs?: number;
}

export interface ParamClassificationResult {
  readonly paramName: string;
  readonly classification: StoredParamClassification;
  readonly totalPairsProvided: number;
  readonly validPairsEvaluated: number;
  readonly agreeingPairs: number;
  readonly disagreeingPairs: number;
  readonly minRequiredAgreeingPairs: number;
  readonly keyDegraded: boolean;
  readonly secondaryBucketStrategy: 'none' | 'url_id_plus_head_fp';
  readonly diffDimensionsObserved: readonly ProbeDiffDimension[];
  readonly firstDisagreementPairId: string | null;
  readonly reason: string;
}

export function getMinAgreeingNoisePairs(): number {
  const entry = getConstant('join.param_noise_min_pairs');
  return typeof entry?.value === 'number' ? entry.value : 59;
}

function normalizeUrlForCompare(raw: string | null): string | null {
  if (raw === null) return null;
  return raw.trim();
}

function isValidProbeHttpStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 200 && status < 400;
}

/**
 * Compares a single `(withParam, withoutParam)` fetch pair across ALL §6.4
 * equivalence dimensions: HTTP status, redirect target, canonical, skeleton,
 * head, body, product ID, price signature, and links fingerprint.
 */
export function compareProbeSnapshots(
  withParam: PageProbeSnapshot,
  withoutParam: PageProbeSnapshot
): { readonly validResponse: boolean; readonly identical: boolean; readonly diffs: readonly ProbeDiffDimension[] } {
  const validResponse =
    isValidProbeHttpStatus(withParam.httpStatus) &&
    isValidProbeHttpStatus(withoutParam.httpStatus);

  const diffs: ProbeDiffDimension[] = [];

  if (withParam.httpStatus !== withoutParam.httpStatus) {
    diffs.push('http_status');
  }
  if (normalizeUrlForCompare(withParam.finalUrl) !== normalizeUrlForCompare(withoutParam.finalUrl)) {
    diffs.push('redirect_target');
  }
  if (
    normalizeUrlForCompare(withParam.canonicalUrl) !==
    normalizeUrlForCompare(withoutParam.canonicalUrl)
  ) {
    diffs.push('canonical_url');
  }
  if (withParam.skelFp !== withoutParam.skelFp) {
    diffs.push('skel_fp');
  }
  if (withParam.headFp !== withoutParam.headFp) {
    diffs.push('head_fp');
  }
  if (withParam.bodyFp !== withoutParam.bodyFp) {
    diffs.push('body_fp');
  }
  if ((withParam.productId ?? null) !== (withoutParam.productId ?? null)) {
    diffs.push('product_id');
  }
  if ((withParam.priceSignature ?? null) !== (withoutParam.priceSignature ?? null)) {
    diffs.push('price_signature');
  }
  if (withParam.linksFp !== withoutParam.linksFp) {
    diffs.push('links_fp');
  }

  return {
    validResponse,
    identical: validResponse && diffs.length === 0,
    diffs,
  };
}

/**
 * Evaluates a candidate query parameter under the §6.4 59-pair agreeing probe rule.
 */
export function classifyUrlParameter(
  input: ParamClassificationInput
): ParamClassificationResult {
  const normalizedName = input.paramName.trim().toLowerCase();
  const minRequired = input.minAgreeingPairs ?? getMinAgreeingNoisePairs();

  const userInputSet = new Set<string>();
  if (input.userInputInventory) {
    for (const name of input.userInputInventory) {
      userInputSet.add(name.trim().toLowerCase());
    }
  }

  // Rule 1: GET form / on-site search inventory -> always `user_input`
  if (userInputSet.has(normalizedName)) {
    return {
      paramName: normalizedName,
      classification: 'user_input',
      totalPairsProvided: input.pairs.length,
      validPairsEvaluated: 0,
      agreeingPairs: 0,
      disagreeingPairs: 0,
      minRequiredAgreeingPairs: minRequired,
      keyDegraded: false,
      secondaryBucketStrategy: 'none',
      diffDimensionsObserved: [],
      firstDisagreementPairId: null,
      reason: 'Matched GET-form or on-site-search user_input parameter inventory (§6.4)',
    };
  }

  let validPairsEvaluated = 0;
  let agreeingPairs = 0;
  let disagreeingPairs = 0;
  const observedDiffs = new Set<ProbeDiffDimension>();
  let firstDisagreementPairId: string | null = null;
  const seenPairIds = new Set<string>();

  for (const pair of input.pairs) {
    // Deduplicate pairId so replaying the same probe cannot inflate agreeing pair count
    if (seenPairIds.has(pair.pairId)) {
      continue;
    }
    seenPairIds.add(pair.pairId);

    const cmp = compareProbeSnapshots(pair.withParam, pair.withoutParam);
    if (!cmp.validResponse) {
      // Transient 5xx/4xx responses cannot count toward noise agreement;
      // however, if one side is 2xx and the other is 4xx/5xx, that is a content/routing difference!
      const oneValid =
        isValidProbeHttpStatus(pair.withParam.httpStatus) !==
        isValidProbeHttpStatus(pair.withoutParam.httpStatus);
      if (oneValid) {
        validPairsEvaluated += 1;
        disagreeingPairs += 1;
        observedDiffs.add('http_status');
        if (firstDisagreementPairId === null) {
          firstDisagreementPairId = pair.pairId;
        }
      }
      continue;
    }

    validPairsEvaluated += 1;
    if (cmp.identical) {
      agreeingPairs += 1;
    } else {
      disagreeingPairs += 1;
      for (const d of cmp.diffs) {
        observedDiffs.add(d);
      }
      if (firstDisagreementPairId === null) {
        firstDisagreementPairId = pair.pairId;
      }
    }
  }

  // Rule 2: Even 1 disagreement on any §6.4 axis promotes parameter to `content`
  if (disagreeingPairs > 0) {
    const diffs = Array.from(observedDiffs).sort();
    return {
      paramName: normalizedName,
      classification: 'content',
      totalPairsProvided: input.pairs.length,
      validPairsEvaluated,
      agreeingPairs,
      disagreeingPairs,
      minRequiredAgreeingPairs: minRequired,
      keyDegraded: false,
      secondaryBucketStrategy: 'none',
      diffDimensionsObserved: diffs,
      firstDisagreementPairId,
      reason: `Observed ${disagreeingPairs} disagreeing probe pair(s) across [${diffs.join(', ')}]`,
    };
  }

  // Rule 3: Noise requires >= 59 valid agreeing pairs with 0 disagreements
  if (agreeingPairs >= minRequired) {
    return {
      paramName: normalizedName,
      classification: 'noise',
      totalPairsProvided: input.pairs.length,
      validPairsEvaluated,
      agreeingPairs,
      disagreeingPairs: 0,
      minRequiredAgreeingPairs: minRequired,
      keyDegraded: false,
      secondaryBucketStrategy: 'none',
      diffDimensionsObserved: [],
      firstDisagreementPairId: null,
      reason: `Verified noise: ${agreeingPairs}/${minRequired} agreeing pairs with 0 disagreements across all §6.4 axes`,
    };
  }

  // Rule 4: Insufficient agreeing pairs -> `unknown` (`key_degraded = true`, coarse `(url_id, head_fp)` bucket)
  return {
    paramName: normalizedName,
    classification: 'unknown',
    totalPairsProvided: input.pairs.length,
    validPairsEvaluated,
    agreeingPairs,
    disagreeingPairs: 0,
    minRequiredAgreeingPairs: minRequired,
    keyDegraded: true,
    secondaryBucketStrategy: 'url_id_plus_head_fp',
    diffDimensionsObserved: [],
    firstDisagreementPairId: null,
    reason: `Insufficient agreeing pairs (${agreeingPairs}/${minRequired}); remains unknown with length-bucket masking and (url_id, head_fp) secondary bucketing`,
  };
}

/**
 * Compiles verified site parameter classifications into a `UrlKeyV2Rules` profile
 * directly consumable by `packages/contract/urlkey` (`computeUrlKeyV2`).
 */
export function buildSiteUrlKeyRules(args: {
  readonly profileRev: string;
  readonly classifications: readonly ParamClassificationResult[];
  readonly includeDefaultNoiseParams?: boolean;
}): UrlKeyV2Rules {
  const paramClasses: Record<string, Exclude<ParamClass, 'unclassified'>> = {};

  if (args.includeDefaultNoiseParams !== false) {
    for (const noiseName of DEFAULT_NOISE_EXACT_PARAMS) {
      paramClasses[noiseName] = 'noise';
    }
  }

  for (const res of args.classifications) {
    if (
      res.classification === 'content' ||
      res.classification === 'noise' ||
      res.classification === 'user_input'
    ) {
      paramClasses[res.paramName] = res.classification;
    }
    // `unknown` parameters are intentionally omitted so urlkey/2 treats them as
    // `unclassified` -> emits name + length-bucket token and sets `key_degraded = true`.
  }

  return {
    profileRev: args.profileRev,
    paramClasses,
  };
}
