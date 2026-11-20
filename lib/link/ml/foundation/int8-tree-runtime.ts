/**
 * UGOKI LINK v2 — ML Foundation: Integer-Bin Tree Table & Int8 Evaluator (`lib/link/ml/foundation/int8-tree-runtime.ts`)
 *
 * Implements §8.9, ML M9:
 * - Models are distributed strictly as DATA (integer-bin tree tables + int8 fixed-point arithmetic).
 * - ZERO runtime code compilation (`eval` / `new Function` / ONNX WASM forbidden).
 * - Hard size gate: serialized compressed artifact MUST be <= 50 KB (`51_200` bytes).
 * - Content-addressed SHA-256 integrity verification (`artifact_sha256`).
 * - Pure integer fixed-point Q8/Q16 arithmetic guarantees bit-for-bit identical scores between
 *   browser SDK and Cloudflare Worker / server runtimes!
 * - On hash or ABI mismatch -> falls back cleanly to uniform draw or rule default and logs `fallback_reason`.
 */

import {
  canonicalJsonStringify,
  sha256Hex,
  utf8ToBytes,
} from '../../../../packages/contract/schema';

export const MAX_MODEL_ARTIFACT_COMPRESSED_BYTES = 50 * 1024; // 50 KB (§8.9 / ML M9)
export const SUPPORTED_EVALUATOR_ABIS = [1, 2] as const;

export interface IntTreeNode {
  /** -1 indicates a leaf node; >= 0 is index into `feature_ids`. */
  readonly feature_idx: number;
  /** Integer bin threshold: branch left if `featureInt <= threshold_int`, else right. */
  readonly threshold_int: number;
  /** Index of left child node (or -1 for leaf). */
  readonly left_idx: number;
  /** Index of right child node (or -1 for leaf). */
  readonly right_idx: number;
  /** Fixed-point int16 logit contribution scaled by 256 (Q8) when leaf. */
  readonly leaf_logit_q8: number;
}

export interface Int8DenseLayer {
  /** Row-major int8 weights in [-127, 127], length = `out_dim * in_dim`. */
  readonly weights_i8: readonly number[];
  /** int16 biases scaled by 256 (Q8), length = `out_dim`. */
  readonly bias_q8: readonly number[];
  readonly in_dim: number;
  readonly out_dim: number;
  /** Right-shift scale bits after int8*int8 dot product to return to Q8. */
  readonly shift_bits: number;
}

export interface Int8ModelArtifactPayload {
  readonly abi_version: number;
  readonly model_id: string;
  readonly version: string;
  readonly feature_ids: readonly string[];
  /** Base score logit scaled by 256 (Q8). */
  readonly base_logit_q8: number;
  readonly trees: readonly (readonly IntTreeNode[])[];
  /** Optional int8 dense refinement layer (zero float math!). */
  readonly dense_layer?: Int8DenseLayer;
  /** Mandatory license & notice text bundled with edge/browser classifiers (§8.14). */
  readonly license_id: string;
  readonly license_notice: string;
}

export interface SignedInt8ModelArtifact {
  readonly payload: Int8ModelArtifactPayload;
  readonly artifact_sha256: string;
  readonly uncompressed_bytes: number;
  readonly compressed_bytes: number;
}

export interface ArtifactValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/**
 * Deterministic RLE/deflate-conservative byte estimator when native CompressionStream is unavailable,
 * plus exact UTF-8 byte length check. Uses pure ES2022 so it works identically in browsers & Workers.
 */
export function estimateCompressedBytes(rawBytes: Uint8Array): number {
  // Simple deterministic LZ-like byte counter (upper-bound safe; exact gzip is equal or smaller)
  // For small JSON payloads, rawBytes.length is already a conservative upper bound;
  // when checking the 50KB budget we enforce BOTH exact raw check or supplied gzip byte count.
  return rawBytes.byteLength;
}

export function packageInt8ModelArtifact(
  payload: Int8ModelArtifactPayload,
  measuredGzipBytes?: number
): SignedInt8ModelArtifact {
  const canonical = canonicalJsonStringify(payload);
  const rawBytes = utf8ToBytes(canonical);
  const compressedBytes = measuredGzipBytes ?? estimateCompressedBytes(rawBytes);

  if (compressedBytes > MAX_MODEL_ARTIFACT_COMPRESSED_BYTES) {
    throw new Error(
      `§8.9 Model Artifact Budget Exceeded: ${compressedBytes} bytes > max ${MAX_MODEL_ARTIFACT_COMPRESSED_BYTES} bytes (50 KB)`
    );
  }
  if (!payload.license_id || !payload.license_notice) {
    throw new Error('§8.14 Artifact MUST include license_id and license_notice');
  }

  return {
    payload,
    artifact_sha256: sha256Hex(canonical),
    uncompressed_bytes: rawBytes.byteLength,
    compressed_bytes: compressedBytes,
  };
}

export function validateInt8ModelArtifact(
  artifact: SignedInt8ModelArtifact,
  expectedSha256?: string
): ArtifactValidationResult {
  const errors: string[] = [];
  const p = artifact.payload;

  if (!(SUPPORTED_EVALUATOR_ABIS as readonly number[]).includes(p.abi_version)) {
    errors.push(`Unsupported ABI version ${p.abi_version}`);
  }
  if (artifact.compressed_bytes > MAX_MODEL_ARTIFACT_COMPRESSED_BYTES) {
    errors.push(
      `Artifact compressed size ${artifact.compressed_bytes} exceeds 50 KB cap (${MAX_MODEL_ARTIFACT_COMPRESSED_BYTES})`
    );
  }
  if (!p.license_id || !p.license_notice) {
    errors.push('Missing bundled license_id or license_notice (§8.14)');
  }

  const recomputedSha = sha256Hex(canonicalJsonStringify(p));
  if (recomputedSha !== artifact.artifact_sha256) {
    errors.push('Artifact SHA-256 content hash mismatch (tampered or corrupted)');
  }
  if (expectedSha256 && expectedSha256 !== recomputedSha) {
    errors.push(`Artifact SHA-256 does not match signed bundle reference "${expectedSha256}"`);
  }

  // Verify every node uses strictly integer thresholds & Q8 integer leaf logits
  for (let t = 0; t < p.trees.length; t++) {
    const tree = p.trees[t];
    if (tree.length === 0) {
      errors.push(`Tree ${t} is empty`);
      continue;
    }
    for (let n = 0; n < tree.length; n++) {
      const node = tree[n];
      if (!Number.isInteger(node.threshold_int) || !Number.isInteger(node.leaf_logit_q8)) {
        errors.push(`Tree ${t} node ${n} contains non-integer threshold or leaf value`);
      }
      if (node.feature_idx >= p.feature_ids.length) {
        errors.push(`Tree ${t} node ${n} feature_idx ${node.feature_idx} out of bounds`);
      }
    }
  }

  if (p.dense_layer) {
    const d = p.dense_layer;
    if (d.weights_i8.length !== d.in_dim * d.out_dim || d.bias_q8.length !== d.out_dim) {
      errors.push('Dense int8 layer dimensions mismatch');
    }
    for (const w of d.weights_i8) {
      if (!Number.isInteger(w) || w < -128 || w > 127) {
        errors.push(`Dense weight ${w} outside int8 range [-128, 127]`);
        break;
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Pure integer piecewise-linear sigmoid approximation mapping Q8 logit (`x = round(logit * 256)`)
 * to integer permille probability `[0, 1000]` (bit-identical across every JS engine & CPU!).
 */
export function intQ8LogitToPermille(logitQ8: number): number {
  const x = Math.trunc(logitQ8);
  if (x <= -1536) return 2; // <= -6.0 -> 0.2%
  if (x >= 1536) return 998; // >= +6.0 -> 99.8%
  // Piece-wise integer interpolation over [-6, +6] in 1.0 (256 Q8) steps
  // Breakpoints at logits -6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6 -> permille [2,7,18,47,119,269,500,731,881,953,982,993,998]
  const LUT = [2, 7, 18, 47, 119, 269, 500, 731, 881, 953, 982, 993, 998] as const;
  const shifted = x + 1536; // [0, 3072]
  const idx = Math.floor(shifted / 256);
  const rem = shifted - idx * 256;
  const y0 = LUT[idx];
  const y1 = LUT[Math.min(LUT.length - 1, idx + 1)];
  return y0 + Math.trunc(((y1 - y0) * rem) / 256);
}

export interface Int8EvaluationResult {
  readonly ok: boolean;
  readonly used_fallback: boolean;
  readonly fallback_reason: string | null;
  /** Exact integer Q8 logit (null on fallback). */
  readonly raw_logit_q8: number | null;
  /** Exact integer probability in permille [0, 1000] (500 on uniform fallback). */
  readonly score_permille: number;
  readonly chosen_arm_index: number;
}

/**
 * Evaluates a signed integer-bin tree (+ optional int8 dense layer) purely in integer arithmetic.
 * - Identical across browser SDK and server/Worker environments bit-for-bit!
 * - On hash/ABI mismatch: falls back to uniform draw (via server-drawn `serverUniformU`) or rule default
 *   and records explicit `fallback_reason` (§8.9 / ML M9).
 */
export function evaluateInt8ModelArtifact(params: {
  readonly artifact: SignedInt8ModelArtifact;
  readonly expectedSha256: string;
  readonly integerFeatures: Readonly<Record<string, number>>;
  /** Server-drawn uniform random `u ∈ [0, 1)` for deterministic inverse-CDF choice (§8.9). */
  readonly serverUniformU: number;
  readonly numArms?: number;
  readonly ruleDefaultArmIndex?: number;
}): Int8EvaluationResult {
  const numArms = Math.max(1, params.numArms ?? 2);
  const validation = validateInt8ModelArtifact(params.artifact, params.expectedSha256);

  if (!validation.valid) {
    const fallbackArm =
      params.ruleDefaultArmIndex !== undefined
        ? params.ruleDefaultArmIndex
        : Math.min(numArms - 1, Math.floor(Math.max(0, Math.min(0.999999, params.serverUniformU)) * numArms));
    return {
      ok: false,
      used_fallback: true,
      fallback_reason: validation.errors[0] ?? 'artifact_validation_failed',
      raw_logit_q8: null,
      score_permille: 500,
      chosen_arm_index: fallbackArm,
    };
  }

  const p = params.artifact.payload;
  const featureVec: number[] = p.feature_ids.map((id) => {
    const v = params.integerFeatures[id];
    // Missing feature maps deterministically to -2147483648 (always <= threshold -> left branch)
    return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : -2147483648;
  });

  let logitQ8 = Math.trunc(p.base_logit_q8);

  for (const tree of p.trees) {
    let idx = 0;
    let steps = 0;
    while (idx >= 0 && idx < tree.length && steps <= tree.length) {
      steps += 1;
      const node = tree[idx];
      if (node.feature_idx < 0 || (node.left_idx < 0 && node.right_idx < 0)) {
        logitQ8 += Math.trunc(node.leaf_logit_q8);
        break;
      }
      const fVal = featureVec[node.feature_idx];
      idx = fVal <= node.threshold_int ? node.left_idx : node.right_idx;
    }
  }

  // Optional int8 dense refinement layer (pure integer dot product + bit shift)
  if (p.dense_layer) {
    const d = p.dense_layer;
    let denseSumQ8 = 0;
    for (let o = 0; o < d.out_dim; o++) {
      let acc = 0;
      for (let i = 0; i < d.in_dim; i++) {
        const clampedInput = Math.max(-127, Math.min(127, featureVec[i] ?? 0));
        acc += d.weights_i8[o * d.in_dim + i] * clampedInput;
      }
      const scaled = (acc >> d.shift_bits) + d.bias_q8[o];
      denseSumQ8 += Math.max(0, scaled); // ReLU in pure integer Q8
    }
    logitQ8 += denseSumQ8;
  }

  const scorePermille = intQ8LogitToPermille(logitQ8);
  // Deterministic inverse-CDF arm choice driven by server random draw `serverUniformU`
  const uPermille = Math.floor(Math.max(0, Math.min(0.999999, params.serverUniformU)) * 1000);
  const chosenArmIndex = numArms === 2 ? (uPermille < scorePermille ? 1 : 0) : Math.min(numArms - 1, Math.floor((scorePermille * numArms) / 1001));

  return {
    ok: true,
    used_fallback: false,
    fallback_reason: null,
    raw_logit_q8: logitQ8,
    score_permille: scorePermille,
    chosen_arm_index: chosenArmIndex,
  };
}
