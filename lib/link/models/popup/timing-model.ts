/**
 * UGOKI LINK v2 — Bundle 6-F.1: Pop-up "When" 3-Tier Ladder & Counterfactual Timing Randomization
 * (`lib/link/models/popup/timing-model.ts`)
 *
 * Implements §8.3, ML M3:
 * - 3-tier "When" ladder (all implemented; upper tiers registered as `challenger` in 4-F registry):
 *   1. `S0_rule`: deterministic rule (scroll depth / dwell ms / exit-intent triggers)
 *   2. `S1_int8_hazard_tree`: discrete-time exit hazard evaluated per section step or 5-second tick
 *      via Bundle 4-F `evaluateInt8ModelArtifact` (<=50 KB int8 tree table, `challenger`)
 *   3. `S2_int8_seq_nn`: compact integer sequential neural net (int8 dense/recurrent update over
 *      event tokens, packaged <=50 KB via 4-F `packageInt8ModelArtifact`, `challenger`)
 * - Counterfactual Timing Randomization (§8.3):
 *   - Draws per-unit timing threshold `τ` deterministically via HMAC from a pre-registered grid
 *     (score quantiles, current rule, and `'no_show'`).
 *   - Records `first_crossing_ms` for EVERY unit (including non-rendering `'no_show'` controls!).
 *   - Compares any two timing arms strictly inside the common triggered cohort exceeding the
 *     lower threshold (`min(τ_A, τ_B)`) so one control serves the entire grid cleanly!
 */

import { drawUniformU } from '../../allocator/hmac';
import { sha256Hex } from '../../../../packages/contract/schema';
import {
  evaluateInt8ModelArtifact,
  intQ8LogitToPermille,
  packageInt8ModelArtifact,
  type Int8ModelArtifactPayload,
  type SignedInt8ModelArtifact,
} from '../../ml/foundation/int8-tree-runtime';
import type { MlModelRegistry } from '../../ml/foundation/registry';

export type PopupTimingRung = 'S0_rule' | 'S1_int8_hazard_tree' | 'S2_int8_seq_nn';

export interface TimingTickObservation {
  readonly t_mono_ms: number;
  readonly tick_kind: 'section_step' | 'tick_5s';
  readonly scroll_depth_pct: number; // [0, 100]
  readonly dwell_ms: number;
  readonly reversals: number;
  readonly exit_intent_signal: boolean;
  /** Compact integer event token IDs observed so far for S2 int8 sequential NN. */
  readonly event_tokens: readonly number[];
}

export interface S0RuleTimingConfig {
  readonly min_dwell_ms: number;
  readonly min_scroll_pct: number;
  readonly trigger_on_exit_intent: boolean;
}

/**
 * Tier 0 (`S0_rule`): Baseline rule evaluator returning exit-hazard score in permille `[0, 1000]`.
 */
export function scoreS0RuleTiming(
  obs: TimingTickObservation,
  rule: S0RuleTimingConfig
): { readonly triggered: boolean; readonly score_permille: number } {
  const dwellHit = obs.dwell_ms >= rule.min_dwell_ms;
  const scrollHit = obs.scroll_depth_pct >= rule.min_scroll_pct;
  const exitHit = rule.trigger_on_exit_intent && obs.exit_intent_signal;
  const triggered = (dwellHit && scrollHit) || exitHit;
  const score = exitHit
    ? 850
    : triggered
      ? 650
      : Math.min(500, Math.round((obs.dwell_ms / Math.max(1, rule.min_dwell_ms)) * 250 + (obs.scroll_depth_pct / Math.max(1, rule.min_scroll_pct)) * 250));
  return { triggered, score_permille: score };
}

/**
 * Tier 1 (`S1_int8_hazard_tree`): Evaluates a <=50 KB integer-bin hazard tree per section step / 5s tick.
 */
export function scoreS1Int8HazardTree(params: {
  readonly artifact: SignedInt8ModelArtifact;
  readonly expectedSha256: string;
  readonly obs: TimingTickObservation;
}): { readonly score_permille: number; readonly used_fallback: boolean } {
  const res = evaluateInt8ModelArtifact({
    artifact: params.artifact,
    expectedSha256: params.expectedSha256,
    integerFeatures: {
      scroll_depth_pct: Math.round(params.obs.scroll_depth_pct),
      dwell_sec: Math.round(params.obs.dwell_ms / 1000),
      reversals: params.obs.reversals,
      exit_intent: params.obs.exit_intent_signal ? 1 : 0,
    },
    serverUniformU: 0.5,
  });
  return { score_permille: res.score_permille, used_fallback: res.used_fallback };
}

export interface Int8SeqGruWeights {
  readonly vocab_size: number;
  readonly hidden_dim: number;
  /** Token embedding table `[vocab_size * hidden_dim]` in int8 [-127, 127]. */
  readonly token_emb_i8: readonly number[];
  /** Recurrent state weight `[hidden_dim]` in int8. */
  readonly rec_weight_i8: readonly number[];
  /** Output readout weight `[hidden_dim]` in int8 + bias in Q8. */
  readonly out_weight_i8: readonly number[];
  readonly out_bias_q8: number;
}

/**
 * Tier 2 (`S2_int8_seq_nn`): Pure integer-arithmetic sequential recurrent cell over event tokens
 * (zero float ops, deterministic bit-identical across browser & server, <=50 KB!).
 */
export function scoreS2Int8SequentialNn(
  eventTokens: readonly number[],
  weights: Int8SeqGruWeights
): { readonly raw_logit_q8: number; readonly score_permille: number } {
  const h = new Array<number>(weights.hidden_dim).fill(0);
  const capped = eventTokens.slice(-32);

  for (const rawTok of capped) {
    const tok = Math.max(0, Math.min(weights.vocab_size - 1, Math.trunc(rawTok)));
    const base = tok * weights.hidden_dim;
    for (let d = 0; d < weights.hidden_dim; d++) {
      const emb = weights.token_emb_i8[base + d] ?? 0;
      const rec = (h[d] * (weights.rec_weight_i8[d] ?? 64)) >> 7;
      // Clamped integer tanh-like activation in [-127, 127]
      const next = rec + emb;
      h[d] = Math.max(-127, Math.min(127, next));
    }
  }

  let logitQ8 = Math.trunc(weights.out_bias_q8);
  for (let d = 0; d < weights.hidden_dim; d++) {
    logitQ8 += (h[d] * (weights.out_weight_i8[d] ?? 0)) >> 4;
  }
  return {
    raw_logit_q8: logitQ8,
    score_permille: intQ8LogitToPermille(logitQ8),
  };
}

/**
 * Registers both S1 (int8 hazard tree) and S2 (int8 sequential NN) into 4-F `MlModelRegistry` as challengers.
 */
export function registerPopupTimingChallengers(params: {
  readonly registry: MlModelRegistry;
  readonly tenantScope: string;
  readonly s1Payload: Int8ModelArtifactPayload;
  readonly s2Weights: Int8SeqGruWeights;
  readonly nowIso: string;
}): { readonly s1Artifact: SignedInt8ModelArtifact; readonly s2Sha256: string } {
  const s1Artifact = packageInt8ModelArtifact(params.s1Payload);
  const s2Bytes = new TextEncoder().encode(JSON.stringify(params.s2Weights));
  if (s2Bytes.byteLength > 50 * 1024) {
    throw new Error(`S2 int8 sequential NN exceeds 50 KB budget (${s2Bytes.byteLength}B)`);
  }
  const s2Sha256 = sha256Hex(JSON.stringify(params.s2Weights));

  params.registry.registerModelVersion({
    model_version_id: `popup_timing_s1_${s1Artifact.payload.version}`,
    model_family: 'popup_timing_s1_hazard_tree',
    tenant_scope: params.tenantScope,
    artifact_sha256: s1Artifact.artifact_sha256,
    abi_version: s1Artifact.payload.abi_version,
    feature_set_version: 'popup_timing_v1',
    label_contract_version: 'exit_before_next_sec_v1',
    dataset_id: 'pending_real_data',
    deletion_generation: params.registry.getDeletionGeneration(),
    code_version: 'wave6_6f_v1',
    runtime_env: 'edge_and_browser_int8',
    seed: 601,
    license_bundle: {
      license_id: s1Artifact.payload.license_id,
      notice_text: s1Artifact.payload.license_notice,
      distribution_scope: 'edge_and_browser_classifier',
    },
    created_at_iso: params.nowIso,
    status: 'challenger',
    contributing_subject_ids: [],
  });

  params.registry.registerModelVersion({
    model_version_id: 'popup_timing_s2_int8_seq_v1',
    model_family: 'popup_timing_s2_seq_nn',
    tenant_scope: params.tenantScope,
    artifact_sha256: s2Sha256,
    abi_version: 1,
    feature_set_version: 'popup_event_tokens_v1',
    label_contract_version: 'exit_before_next_sec_v1',
    dataset_id: 'pending_real_data',
    deletion_generation: params.registry.getDeletionGeneration(),
    code_version: 'wave6_6f_v1',
    runtime_env: 'edge_and_browser_int8',
    seed: 602,
    license_bundle: {
      license_id: 'Proprietary-UGOKI-LINK',
      notice_text: 'UGOKI LINK v2 S2 int8 sequential timing challenger',
      distribution_scope: 'edge_and_browser_classifier',
    },
    created_at_iso: params.nowIso,
    status: 'challenger',
    contributing_subject_ids: [],
  });

  return { s1Artifact, s2Sha256 };
}

// =========================================================================
// Counterfactual Timing Randomization (§8.3)
// =========================================================================

export interface TimingGridCandidate {
  readonly arm_id: string;
  readonly kind: 'score_quantile' | 'current_rule' | 'no_show';
  /** Hazard score threshold in permille `[0, 1000]` (null for `no_show`). */
  readonly threshold_permille: number | null;
  readonly weight: number;
}

export interface TimingUnitTrace {
  readonly unit_id: string;
  readonly assigned_arm_id: string;
  readonly assigned_threshold_permille: number | null; // null = no_show control
  /** First tick ms at which the unit's score crossed EACH threshold in the pre-registered grid. */
  readonly first_crossing_ms_by_threshold: Readonly<Record<number, number | null>>;
  readonly rendered_popup: boolean;
  readonly outcome_converted: number;
}

/**
 * Deterministically draws a timing threshold arm from the pre-registered grid (including `no_show`).
 */
export function drawTimingThresholdArm(params: {
  readonly hmacSecret: string;
  readonly experimentId: string;
  readonly unitId: string;
  readonly grid: readonly TimingGridCandidate[];
}): { readonly candidate: TimingGridCandidate; readonly propensity: number } {
  const totalW = params.grid.reduce((s, g) => s + Math.max(0, g.weight), 0);
  const u = drawUniformU(`${params.hmacSecret}:popup_timing:${params.experimentId}`, params.unitId);
  let cum = 0;
  for (const g of params.grid) {
    const p = g.weight / totalW;
    cum += p;
    if (u < cum) return { candidate: g, propensity: p };
  }
  const last = params.grid[params.grid.length - 1];
  return { candidate: last, propensity: last.weight / totalW };
}

/**
 * Evaluates a unit's counterfactual first-crossing times across ALL pre-registered thresholds
 * up to the point where the unit actually receives a popup (or PV ends for `no_show`, §8.3).
 */
export function recordCounterfactualTimingCrossings(params: {
  readonly unitId: string;
  readonly assignedCandidate: TimingGridCandidate;
  readonly gridThresholdsPermille: readonly number[];
  readonly tickScores: ReadonlyArray<{ readonly t_mono_ms: number; readonly score_permille: number }>;
  readonly outcomeConverted: number;
}): TimingUnitTrace {
  const crossings: Record<number, number | null> = {};
  for (const thr of params.gridThresholdsPermille) crossings[thr] = null;

  let rendered = false;
  for (const tick of params.tickScores) {
    for (const thr of params.gridThresholdsPermille) {
      if (crossings[thr] === null && tick.score_permille >= thr) {
        crossings[thr] = tick.t_mono_ms;
      }
    }
    // Once a unit actually renders its assigned popup, later post-popup crossings are censored (§8.3)
    if (
      params.assignedCandidate.kind !== 'no_show' &&
      params.assignedCandidate.threshold_permille !== null &&
      tick.score_permille >= params.assignedCandidate.threshold_permille
    ) {
      rendered = true;
      break;
    }
  }

  return {
    unit_id: params.unitId,
    assigned_arm_id: params.assignedCandidate.arm_id,
    assigned_threshold_permille: params.assignedCandidate.threshold_permille,
    first_crossing_ms_by_threshold: crossings,
    rendered_popup: rendered,
    outcome_converted: params.outcomeConverted,
  };
}

/**
 * Compares two timing arms (or one arm vs `no_show`) strictly inside the common triggered cohort
 * that crossed the LOWER of the two thresholds (§8.3).
 */
export function compareTimingArmsInCommonTriggeredSet(params: {
  readonly traces: readonly TimingUnitTrace[];
  readonly armAId: string;
  readonly thresholdAPermille: number;
  readonly armBId: string;
  readonly thresholdBPermille: number | null; // null when armB is `no_show`
}): {
  readonly common_filter_threshold_permille: number;
  readonly arm_a_n: number;
  readonly arm_a_rate: number;
  readonly arm_b_n: number;
  readonly arm_b_rate: number;
  readonly diff_a_minus_b: number;
} {
  const lowerThreshold =
    params.thresholdBPermille === null
      ? params.thresholdAPermille
      : Math.min(params.thresholdAPermille, params.thresholdBPermille);

  let aN = 0;
  let aCv = 0;
  let bN = 0;
  let bCv = 0;

  for (const tr of params.traces) {
    if (tr.first_crossing_ms_by_threshold[lowerThreshold] === null || tr.first_crossing_ms_by_threshold[lowerThreshold] === undefined) {
      continue;
    }
    if (tr.assigned_arm_id === params.armAId) {
      aN += 1;
      aCv += tr.outcome_converted;
    } else if (tr.assigned_arm_id === params.armBId) {
      bN += 1;
      bCv += tr.outcome_converted;
    }
  }

  const rateA = aN > 0 ? aCv / aN : 0;
  const rateB = bN > 0 ? bCv / bN : 0;
  return {
    common_filter_threshold_permille: lowerThreshold,
    arm_a_n: aN,
    arm_a_rate: Number(rateA.toFixed(6)),
    arm_b_n: bN,
    arm_b_rate: Number(rateB.toFixed(6)),
    diff_a_minus_b: Number((rateA - rateB).toFixed(6)),
  };
}
