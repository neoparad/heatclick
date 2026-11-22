/**
 * UGOKI LINK v2 — Generative Model Thin Provider Layer (Bundle 4-G, `lib/link/ml/llm/provider.ts`)
 *
 * Implements §8.12, §8.14, §14 Decision 31-a / 31-c, Addendum §3–§4:
 * - Single provider-agnostic interface supporting BOTH `muse-glimmer-30b` (Apache 2.0) and
 *   `gemma-4` (`gemma-4-12b` | `gemma-4-26b` | `gemma-4-31b`, with explicit license review flag)
 *   until Japanese evaluation + license review finalize selection (Decision 31-a).
 * - Strictly SERVER-ONLY (`browser` / `edge_worker` rejected at runtime).
 * - 30B inference VRAM, latency & cost estimator (for Completion Report §6).
 * - Independent cost caps for `inference`, `jev`, and `retry`.
 * - Input firewall: accepts ONLY public page text (wrapped in `UntrustedValue`) and aggregate /
 *   cluster features; rejects visitor-level rows at BOTH compile time (`never`) and runtime.
 * - On failure or budget exhaustion: returns `status: 'not_collected'` with fallback to rules or
 *   existing artifacts (NEVER fabricates missing explanations!).
 */

import {
  wrapUntrusted,
  type UntrustedValue,
} from '../../../../packages/contract/response';
import { canonicalJsonStringify, sha256Hex } from '../../../../packages/contract/schema';

export type GenerativeModelId =
  | 'muse-glimmer-30b'
  | 'gemma-4-12b'
  | 'gemma-4-26b'
  | 'gemma-4-31b';

export type ExecutionRuntimeKind = 'server_gpu' | 'server_ci_stub' | 'browser' | 'edge_worker';

export type QuantizationMode = 'bf16' | 'fp8' | 'int4_awq';

export interface GenerativeModelCatalogEntry {
  readonly model_id: GenerativeModelId;
  readonly params_billion: number;
  readonly num_layers: number;
  readonly num_kv_heads: number;
  readonly head_dim: number;
  readonly hidden_dim: number;
  readonly license_id: string;
  readonly license_text_reviewed: boolean;
  readonly commercial_distribution_allowed: boolean;
}

export const GENERATIVE_MODEL_CATALOG: Readonly<Record<GenerativeModelId, GenerativeModelCatalogEntry>> = {
  'muse-glimmer-30b': {
    model_id: 'muse-glimmer-30b',
    params_billion: 30,
    num_layers: 64,
    num_kv_heads: 8,
    head_dim: 128,
    hidden_dim: 5120,
    license_id: 'Apache-2.0',
    license_text_reviewed: false, // §8.14: official page states Apache 2.0; LICENSE file pending review
    commercial_distribution_allowed: true,
  },
  'gemma-4-12b': {
    model_id: 'gemma-4-12b',
    params_billion: 12,
    num_layers: 48,
    num_kv_heads: 8,
    head_dim: 256,
    hidden_dim: 3840,
    license_id: 'Gemma-4-License-Pending-Review',
    license_text_reviewed: false,
    commercial_distribution_allowed: false,
  },
  'gemma-4-26b': {
    model_id: 'gemma-4-26b',
    params_billion: 26,
    num_layers: 56,
    num_kv_heads: 8,
    head_dim: 256,
    hidden_dim: 4608,
    license_id: 'Gemma-4-License-Pending-Review',
    license_text_reviewed: false,
    commercial_distribution_allowed: false,
  },
  'gemma-4-31b': {
    model_id: 'gemma-4-31b',
    params_billion: 31,
    num_layers: 62,
    num_kv_heads: 8,
    head_dim: 256,
    hidden_dim: 5120,
    license_id: 'Gemma-4-License-Pending-Review',
    license_text_reviewed: false,
    commercial_distribution_allowed: false,
  },
};

export interface InferenceMemoryEstimateInput {
  readonly model_id: GenerativeModelId;
  readonly quantization: QuantizationMode;
  readonly max_input_tokens: number;
  readonly max_output_tokens: number;
  readonly max_concurrency: number;
  readonly active_lora_adapters: number;
  readonly lora_rank?: number; // default 16
  readonly gpu_hourly_cost_usd?: number;
}

export interface InferenceMemoryEstimateResult {
  readonly model_id: GenerativeModelId;
  readonly quantization: QuantizationMode;
  readonly weights_vram_gib: number;
  readonly kv_cache_vram_gib: number;
  readonly lora_adapters_vram_gib: number;
  readonly activation_overhead_gib: number;
  readonly total_vram_gib: number;
  readonly recommended_gpu_profile: string;
  readonly estimated_p95_latency_ms: number;
  readonly estimated_cost_per_1k_requests_usd: number;
  readonly unverified_assumptions_note: string;
}

/**
 * Estimates VRAM, p95 latency, and unit cost for 30B-class server inference (§8.14 / Addendum §6).
 */
export function estimateGenerativeInferenceResources(
  input: InferenceMemoryEstimateInput
): InferenceMemoryEstimateResult {
  const spec = GENERATIVE_MODEL_CATALOG[input.model_id];
  const bytesPerParam =
    input.quantization === 'bf16' ? 2.0 : input.quantization === 'fp8' ? 1.05 : 0.58;
  const GiB = 1024 ** 3;

  // 1. Model weights VRAM
  const weightsGiB = (spec.params_billion * 1e9 * bytesPerParam) / GiB;

  // 2. KV cache VRAM: 2 (K+V) * layers * kv_heads * head_dim * 2B (BF16 KV) * seq_len * concurrency
  const totalSeq = Math.max(256, input.max_input_tokens + input.max_output_tokens);
  const kvBytesPerToken = 2 * spec.num_layers * spec.num_kv_heads * spec.head_dim * 2;
  const kvCacheGiB = (kvBytesPerToken * totalSeq * Math.max(1, input.max_concurrency)) / GiB;

  // 3. LoRA adapter weights (q, k, v, o, gate, up, down = 7 target projections * 2 matrices A/B * rank * hidden * 2B)
  const rank = input.lora_rank ?? 16;
  const bytesPerAdapter = spec.num_layers * 7 * 2 * rank * spec.hidden_dim * 2;
  const loraGiB = (bytesPerAdapter * Math.max(0, input.active_lora_adapters)) / GiB;

  // 4. CUDA graph / activation workspace overhead (~18% of base + 1.5 GiB floor)
  const subtotal = weightsGiB + kvCacheGiB + loraGiB;
  const overheadGiB = Math.max(1.5, subtotal * 0.18);
  const totalGiB = subtotal + overheadGiB;

  let recommendedGpu = '1x L40S 48GB';
  let defaultHourlyUsd = 1.4;
  let tokensPerSec = 55;
  if (totalGiB > 80) {
    recommendedGpu = '2x H100 80GB (tensor-parallel=2)';
    defaultHourlyUsd = 6.5;
    tokensPerSec = 95;
  } else if (totalGiB > 44) {
    recommendedGpu = '1x H100 80GB (or 1x A100 80GB)';
    defaultHourlyUsd = 3.2;
    tokensPerSec = 70;
  } else if (totalGiB > 22) {
    recommendedGpu = '1x L40S 48GB (or 1x A6000 48GB)';
    defaultHourlyUsd = 1.4;
    tokensPerSec = 55;
  } else {
    recommendedGpu = '1x L4 24GB';
    defaultHourlyUsd = 0.8;
    tokensPerSec = 42;
  }

  const hourly = input.gpu_hourly_cost_usd ?? defaultHourlyUsd;
  // Rough p95 latency = prefill + decode * concurrency queuing factor
  const prefillMs = (input.max_input_tokens / (tokensPerSec * 12)) * 1000;
  const decodeMs = (input.max_output_tokens / tokensPerSec) * 1000;
  const p95LatencyMs = Math.round((prefillMs + decodeMs) * (1 + 0.12 * Math.max(0, input.max_concurrency - 1)));

  const secPerReq = (prefillMs + decodeMs) / 1000 / Math.max(1, Math.min(4, input.max_concurrency));
  const costPer1k = (secPerReq * 1000 * hourly) / 3600;

  return {
    model_id: input.model_id,
    quantization: input.quantization,
    weights_vram_gib: Number(weightsGiB.toFixed(2)),
    kv_cache_vram_gib: Number(kvCacheGiB.toFixed(2)),
    lora_adapters_vram_gib: Number(loraGiB.toFixed(2)),
    activation_overhead_gib: Number(overheadGiB.toFixed(2)),
    total_vram_gib: Number(totalGiB.toFixed(2)),
    recommended_gpu_profile: recommendedGpu,
    estimated_p95_latency_ms: p95LatencyMs,
    estimated_cost_per_1k_requests_usd: Number(costPer1k.toFixed(4)),
    unverified_assumptions_note:
      'Analytical estimate pending real GPU benchmark after Owner Decision 31-c compute provisioning; real p95 latency and exact GQA/MoE memory footprint must be measured on target hardware.',
  };
}

export class ProhibitedRuntimeEnvironmentError extends Error {
  public readonly runtime: ExecutionRuntimeKind;

  constructor(runtime: ExecutionRuntimeKind) {
    super(
      `§8.14 Runtime Isolation Violation: Foundation model / LoRA adapters are SERVER-ONLY and cannot run in "${runtime}". Distribute only <=50 KB int8 classifiers to browser/edge.`
    );
    this.name = 'ProhibitedRuntimeEnvironmentError';
    this.runtime = runtime;
  }
}

export class VisitorRowProhibitedError extends Error {
  public readonly forbiddenKeys: readonly string[];

  constructor(forbiddenKeys: readonly string[]) {
    super(
      `§8.12 Privacy Violation: Generative models MUST NEVER receive per-visitor rows (found: ${forbiddenKeys.join(', ')}). Only public page text and aggregate/cluster features are permitted.`
    );
    this.name = 'VisitorRowProhibitedError';
    this.forbiddenKeys = forbiddenKeys;
  }
}

const FORBIDDEN_VISITOR_KEYS: ReadonlySet<string> = new Set([
  'visitor_id',
  'visitorId',
  'pv_id',
  'pvId',
  'session_id',
  'sessionId',
  'member_hash',
  'memberHash',
  'user_id',
  'userId',
  'raw_visitor_row',
  'visitor_row',
  'cookie',
  'ip',
  'client_ip',
  'email',
]);

const MAX_PROVIDER_SCAN_NODES = 100_000;

/**
 * [M-18] Explicit stack-based iterative visitor-key & prohibited-provenance scanner
 * (`WeakSet` cycle protection + fail-closed if node count > 100,000).
 */
function scanObjectForVisitorKeys(root: unknown, found: Set<string>): void {
  if (root === null || root === undefined || typeof root !== 'object') return;
  const visited = new WeakSet<object>();
  const stack: unknown[] = [root];
  let scannedNodes = 0;

  while (stack.length > 0) {
    const curr = stack.pop();
    if (curr === null || curr === undefined || typeof curr !== 'object') {
      continue;
    }
    if (visited.has(curr)) {
      continue;
    }
    visited.add(curr);
    scannedNodes += 1;
    if (scannedNodes > MAX_PROVIDER_SCAN_NODES) {
      found.add('__payload_node_limit_exceeded_100000__');
      return;
    }

    if (Array.isArray(curr)) {
      for (let i = curr.length - 1; i >= 0; i -= 1) {
        stack.push(curr[i]);
      }
      continue;
    }

    const rec = curr as Record<string, unknown>;
    for (const k of Object.keys(rec)) {
      const v = rec[k];
      if (v !== undefined && v !== null) {
        if (FORBIDDEN_VISITOR_KEYS.has(k)) {
          found.add(k);
        }
        if (typeof v === 'object') {
          stack.push(v);
        }
      }
    }
  }
}

export function assertServerOnlyRuntime(runtime: ExecutionRuntimeKind): void {
  if (runtime === 'browser' || runtime === 'edge_worker') {
    throw new ProhibitedRuntimeEnvironmentError(runtime);
  }
}

export function assertNoVisitorRowPayload(payload: unknown): void {
  const found = new Set<string>();
  scanObjectForVisitorKeys(payload, found);
  if (found.size > 0) {
    throw new VisitorRowProhibitedError(Array.from(found).sort());
  }
}

export type CostCategory = 'inference' | 'jev' | 'retry';

export interface CostCapConfig {
  readonly inference_max_usd: number;
  readonly jev_max_usd: number;
  readonly retry_max_usd: number;
}

export class LlmCostBudgetGuard {
  private readonly caps: CostCapConfig;
  private readonly spent: Record<CostCategory, number> = {
    inference: 0,
    jev: 0,
    retry: 0,
  };

  constructor(caps: CostCapConfig) {
    this.caps = { ...caps };
  }

  public canSpend(category: CostCategory, amountUsd: number): boolean {
    const cap =
      category === 'inference'
        ? this.caps.inference_max_usd
        : category === 'jev'
          ? this.caps.jev_max_usd
          : this.caps.retry_max_usd;
    return this.spent[category] + amountUsd <= cap;
  }

  public recordSpend(category: CostCategory, amountUsd: number): boolean {
    if (!this.canSpend(category, amountUsd)) {
      return false;
    }
    this.spent[category] += Math.max(0, amountUsd);
    return true;
  }

  public getSpent(): Readonly<Record<CostCategory, number>> {
    return { ...this.spent };
  }
}

export interface GenerativeInvokeRequest {
  readonly task: 'section_reading' | 'promise_gap' | 'change_semantics' | 'cluster_naming' | 'weekly_driver';
  readonly runtime: ExecutionRuntimeKind;
  readonly prompt_version: string;
  readonly taxonomy_version: string;
  readonly preprocess_version: string;
  readonly adapter_version_id?: string | null;
  /** Public page text strictly wrapped as UntrustedValue (§8.14 / §11.5 I7). */
  readonly public_page_texts?: readonly UntrustedValue[];
  /** Aggregate / cluster summary numbers ONLY (never per-visitor rows!). */
  readonly aggregate_context?: Readonly<Record<string, unknown>>;
  readonly estimated_cost_usd?: number;
  readonly is_retry?: boolean;

  // Compile-time poison guards blocking visitor-level fields
  readonly visitor_id?: never;
  readonly pv_id?: never;
  readonly session_id?: never;
  readonly member_hash?: never;
}

export interface GenerativeInvokeResponse {
  readonly ok: boolean;
  readonly status: 'ok' | 'not_collected';
  readonly fallback_used: 'none' | 'rule_or_existing_artifact';
  readonly fallback_reason: string | null;
  readonly model_id: GenerativeModelId;
  readonly model_version: string;
  readonly adapter_version_id: string | null;
  readonly inference_config_hash: string;
  readonly output_json: Readonly<Record<string, unknown>> | null;
  readonly confidence: number | null;
}

export interface GenerativeModelProvider {
  readonly model_id: GenerativeModelId;
  readonly model_version: string;
  invoke(request: GenerativeInvokeRequest): Promise<GenerativeInvokeResponse>;
}

/**
 * Wraps raw public page text safely in `UntrustedValue` before entering any generative model.
 */
export function wrapPublicPageTextForLlm(rawText: string, lang: string | null = 'ja'): UntrustedValue {
  return wrapUntrusted(rawText, 'page_content', { lang });
}

/**
 * Provider-agnostic deterministic CI stub implementing BOTH `muse-glimmer-30b` and `gemma-4-*`.
 * Enforces server-only runtime, visitor-row firewall, cost budget guard, and no-fabrication fallback.
 */
export function createDeterministicGenerativeProvider(options: {
  readonly model_id: GenerativeModelId;
  readonly model_version: string;
  readonly costGuard: LlmCostBudgetGuard;
  readonly simulateFailure?: boolean;
  readonly customResponder?: (req: GenerativeInvokeRequest) => {
    readonly output_json: Readonly<Record<string, unknown>>;
    readonly confidence: number;
  };
}): GenerativeModelProvider {
  return {
    model_id: options.model_id,
    model_version: options.model_version,

    async invoke(request: GenerativeInvokeRequest): Promise<GenerativeInvokeResponse> {
      // 1. Hard server-only enforcement (§8.14)
      assertServerOnlyRuntime(request.runtime);

      // 2. Hard visitor-row firewall (§8.12 / Addendum §4)
      assertNoVisitorRowPayload(request);

      const configHash = sha256Hex(
        canonicalJsonStringify({
          model_id: options.model_id,
          model_version: options.model_version,
          adapter_version_id: request.adapter_version_id ?? null,
          prompt_version: request.prompt_version,
          taxonomy_version: request.taxonomy_version,
          preprocess_version: request.preprocess_version,
        })
      ).slice(0, 24);

      // 3. Cost cap enforcement (inference & retry tracked separately, §8.14)
      const costCategory: CostCategory = request.is_retry ? 'retry' : 'inference';
      const costUsd = request.estimated_cost_usd ?? 0.002;
      if (!options.costGuard.recordSpend(costCategory, costUsd)) {
        return {
          ok: false,
          status: 'not_collected',
          fallback_used: 'rule_or_existing_artifact',
          fallback_reason: `cost_cap_exceeded:${costCategory}`,
          model_id: options.model_id,
          model_version: options.model_version,
          adapter_version_id: request.adapter_version_id ?? null,
          inference_config_hash: configHash,
          output_json: null,
          confidence: null,
        };
      }

      // 4. Outage fallback: NEVER fabricate explanations when model is down (§8.14)
      if (options.simulateFailure) {
        return {
          ok: false,
          status: 'not_collected',
          fallback_used: 'rule_or_existing_artifact',
          fallback_reason: 'provider_unavailable',
          model_id: options.model_id,
          model_version: options.model_version,
          adapter_version_id: request.adapter_version_id ?? null,
          inference_config_hash: configHash,
          output_json: null,
          confidence: null,
        };
      }

      if (options.customResponder) {
        const res = options.customResponder(request);
        return {
          ok: true,
          status: 'ok',
          fallback_used: 'none',
          fallback_reason: null,
          model_id: options.model_id,
          model_version: options.model_version,
          adapter_version_id: request.adapter_version_id ?? null,
          inference_config_hash: configHash,
          output_json: res.output_json,
          confidence: res.confidence,
        };
      }

      const joined = (request.public_page_texts ?? []).map((u) => u.value ?? '').join(' ');
      const hasPrice = /円|¥|価格|料金|税込/.test(joined);
      const hasComparison = /比較|一覧|ランキング|違い/.test(joined);
      const hasCaseStudy = /実例|事例|レビュー|体験談|口コミ/.test(joined);

      return {
        ok: true,
        status: 'ok',
        fallback_used: 'none',
        fallback_reason: null,
        model_id: options.model_id,
        model_version: options.model_version,
        adapter_version_id: request.adapter_version_id ?? null,
        inference_config_hash: configHash,
        output_json: {
          role: hasComparison ? 'comparison_table' : hasPrice ? 'pricing_offer' : 'explanatory_body',
          answered_question: hasPrice ? '料金と条件はいくらか' : '特徴と選び方は何か',
          claim: hasComparison ? '複数候補の比較提示' : '製品特徴の説明',
          has_price: hasPrice,
          has_comparison: hasComparison,
          has_case_study: hasCaseStudy,
        },
        confidence: 0.78,
      };
    },
  };
}
