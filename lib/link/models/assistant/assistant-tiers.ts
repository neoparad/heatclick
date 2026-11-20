/**
 * UGOKI LINK v2 — Wave 6 (Bundle 6-D.3): 3-Tier On-Page Assistant & A3 Sandbox Contract
 *
 * Implements Master Architecture v2 §8.5, §10.3, §10.11:
 *   - Tier 1 (`tier1_question_jump`): curated question buttons jumping straight to `sec_fp`
 *   - Tier 2 (`tier2_extractive`): verbatim extractive passage with exact `(sec_fp, body_fp)` citation
 *   - Tier 3 (`tier3_generative_cited`): cited generative answer strictly gated by:
 *       1. `human_labeled_questions_count >= 200` per site
 *       2. Exact Clopper-Pearson 95% lower confidence bound of faithfulness >= owner threshold (default 0.90)
 *       3. Every generated answer carries valid `(sec_fp, body_fp)` citations (zero uncited fallback -> Tier 2)
 *       4. Registered as `challenger` in 4-F `MlModelRegistry` (never auto-promoted)
 *   - A3 Sandbox Contract (§10.3 / §10.11):
 *       - Cross-origin sandbox container (never same-origin script privilege escalation)
 *       - Host-owned close & navigation controls
 *       - Disclosable-only context (zero cookies, tokens, member PII, margin)
 *       - Blocked on pages containing password or payment/checkout inputs
 *       - Deployed bundle hash must match human-approved hash
 *       - History-mutation kill switch immediately unmounts widget on violation
 */

import { sha256Hex } from '../../../../packages/contract/schema';
import type { MlModelRegistry, ModelRegistryEntry } from '../../ml/foundation/registry';

// =========================================================================
// 1. Constants & Types
// =========================================================================

export const ASSISTANT_TIERS = [
  'tier1_question_jump',
  'tier2_extractive',
  'tier3_generative_cited',
] as const;

export type AssistantTier = (typeof ASSISTANT_TIERS)[number];

/** Minimum human-labeled site evaluation questions required to unlock Tier 3 (§8.5). */
export const MIN_TIER3_HUMAN_LABELED_QUESTIONS = 200;

/** Default owner minimum faithfulness 95% lower confidence bound to unlock Tier 3. */
export const DEFAULT_OWNER_FAITHFULNESS_FLOOR = 0.9;

export interface IndexedPageSection {
  readonly page_id: string;
  readonly sec_fp: string;
  readonly body_fp: string;
  readonly heading: string;
  readonly verbatim_text: string;
  readonly curated_questions: ReadonlyArray<string>;
}

export interface AssistantSectionCitation {
  readonly page_id: string;
  readonly sec_fp: string;
  readonly body_fp: string;
  readonly quote_start?: number;
  readonly quote_end?: number;
}

export interface Tier3FaithfulnessEvaluation {
  readonly site_id: string;
  readonly evaluated_at: string;
  readonly human_labeled_questions_count: number;
  readonly faithful_count: number;
  readonly owner_min_faithfulness_threshold?: number;
  readonly evaluation_ref_id: string;
}

export interface Tier3GateResult {
  readonly eligible: boolean;
  readonly human_labeled_questions_count: number;
  readonly required_questions: number;
  readonly observed_faithfulness_rate: number;
  readonly faithfulness_lcb_95: number;
  readonly owner_threshold: number;
  readonly unmet_gates: ReadonlyArray<{
    readonly id: string;
    readonly required: number | string;
    readonly observed: number | string;
    readonly unlock: string;
  }>;
}

export interface Tier1JumpOption {
  readonly question_label: string;
  readonly target_sec_fp: string;
  readonly target_body_fp: string;
  readonly target_heading: string;
}

export interface Tier3GeneratorOutput {
  readonly answer_text: string;
  readonly cited_sec_fps: ReadonlyArray<string>;
  readonly model_version: string;
}

export interface AssistantAnswerRequest {
  readonly site_id: string;
  readonly page_id: string;
  readonly user_question?: string;
  readonly requested_tier: AssistantTier;
  readonly sections: ReadonlyArray<IndexedPageSection>;
  readonly tier3_evaluation?: Tier3FaithfulnessEvaluation | null;
  readonly sandbox_state?: A3SandboxMountInput | null;
  /**
   * Optional injected generator callback (used ONLY when Tier 3 passes all gates).
   * Keeps this module zero-network and deterministically testable.
   */
  readonly generateTier3?: (params: {
    readonly question: string;
    readonly grounded_sections: ReadonlyArray<IndexedPageSection>;
  }) => Tier3GeneratorOutput;
}

export interface AssistantAnswerResponse {
  readonly allowed: boolean;
  readonly sandbox_check: A3SandboxVerificationResult;
  readonly requested_tier: AssistantTier;
  readonly served_tier: AssistantTier | null;
  readonly fallback_from_tier3: boolean;
  readonly fallback_reason: string | null;
  readonly ai_generated_label: boolean;
  readonly evidence_level: 'observed' | 'inferred';
  readonly jump_options: ReadonlyArray<Tier1JumpOption>;
  readonly extractive_snippet: string | null;
  readonly generative_answer: string | null;
  readonly citations: ReadonlyArray<AssistantSectionCitation>;
  readonly tier3_gate: Tier3GateResult | null;
}

// =========================================================================
// 2. Exact Clopper-Pearson 95% Lower Confidence Bound
// =========================================================================

function logGamma(z: number): number {
  // Lanczos approximation (g = 7, n = 9)
  const coeffs = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const shifted = z - 1;
  let x = coeffs[0];
  for (let i = 1; i < coeffs.length; i++) {
    x += coeffs[i] / (shifted + i);
  }
  const t = shifted + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(x);
}

function betacf(a: number, b: number, x: number): number {
  const maxIter = 200;
  const eps = 3e-12;
  const fpMin = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < fpMin) d = fpMin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpMin) d = fpMin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpMin) c = fpMin;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpMin) d = fpMin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpMin) c = fpMin;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < eps) break;
  }
  return h;
}

function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betacf(a, b, x)) / a;
  }
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/**
 * Exact two-sided 95% (alpha/2 = 0.025) Clopper-Pearson lower confidence bound
 * for binomial proportion k / n: solves I_p(k, n - k + 1) = alpha / 2 via bisection.
 */
export function computeClopperPearsonLowerBound(
  successes: number,
  trials: number,
  alpha = 0.05
): number {
  if (!Number.isInteger(trials) || trials <= 0) return 0;
  if (!Number.isInteger(successes) || successes <= 0) return 0;
  if (successes >= trials) {
    return Math.pow(alpha / 2, 1 / trials);
  }
  const target = alpha / 2;
  let lo = 0;
  let hi = successes / trials;
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    const cdf = regularizedIncompleteBeta(mid, successes, trials - successes + 1);
    if (cdf < target) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return Number((0.5 * (lo + hi)).toFixed(6));
}

// =========================================================================
// 3. Tier 3 Faithfulness Gate Evaluator
// =========================================================================

export function evaluateTier3FaithfulnessGate(
  evaluation: Tier3FaithfulnessEvaluation | null | undefined
): Tier3GateResult {
  const threshold = Math.min(
    0.99,
    Math.max(0.8, evaluation?.owner_min_faithfulness_threshold ?? DEFAULT_OWNER_FAITHFULNESS_FLOOR)
  );

  if (!evaluation) {
    return {
      eligible: false,
      human_labeled_questions_count: 0,
      required_questions: MIN_TIER3_HUMAN_LABELED_QUESTIONS,
      observed_faithfulness_rate: 0,
      faithfulness_lcb_95: 0,
      owner_threshold: threshold,
      unmet_gates: [
        {
          id: 'assistant.tier3_eval_missing',
          required: MIN_TIER3_HUMAN_LABELED_QUESTIONS,
          observed: 0,
          unlock: 'Run site human-labeled faithfulness evaluation with >= 200 questions',
        },
      ],
    };
  }

  const n = Math.max(0, Math.floor(evaluation.human_labeled_questions_count));
  const k = Math.max(0, Math.min(n, Math.floor(evaluation.faithful_count)));
  const rate = n > 0 ? Number((k / n).toFixed(6)) : 0;
  const lcb = computeClopperPearsonLowerBound(k, n, 0.05);

  const unmet: Array<{
    readonly id: string;
    readonly required: number | string;
    readonly observed: number | string;
    readonly unlock: string;
  }> = [];

  if (n < MIN_TIER3_HUMAN_LABELED_QUESTIONS) {
    unmet.push({
      id: 'assistant.tier3_min_labeled_questions',
      required: MIN_TIER3_HUMAN_LABELED_QUESTIONS,
      observed: n,
      unlock: `Collect and human-label at least ${MIN_TIER3_HUMAN_LABELED_QUESTIONS} site questions`,
    });
  }

  if (lcb < threshold) {
    unmet.push({
      id: 'assistant.tier3_faithfulness_lcb',
      required: threshold,
      observed: lcb,
      unlock: `Achieve exact 95% Clopper-Pearson faithfulness LCB >= ${threshold} on >= ${MIN_TIER3_HUMAN_LABELED_QUESTIONS} labeled questions`,
    });
  }

  return {
    eligible: unmet.length === 0,
    human_labeled_questions_count: n,
    required_questions: MIN_TIER3_HUMAN_LABELED_QUESTIONS,
    observed_faithfulness_rate: rate,
    faithfulness_lcb_95: lcb,
    owner_threshold: threshold,
    unmet_gates: unmet,
  };
}

// =========================================================================
// 4. A3 Sandbox Isolation Contract (§10.3 / §10.11)
// =========================================================================

export interface A3SandboxMountInput {
  readonly host_origin: string;
  readonly sandbox_origin: string;
  readonly iframe_sandbox_tokens: ReadonlyArray<string>;
  readonly host_owns_close_control: boolean;
  readonly host_owns_navigation: boolean;
  readonly context_disclosable_only: boolean;
  readonly contains_password_field: boolean;
  readonly contains_payment_field: boolean;
  readonly page_category?: 'content' | 'lp' | 'product' | 'checkout' | 'auth' | 'account';
  readonly human_approved_bundle_hash: string;
  readonly deployed_bundle_hash: string;
  readonly history_mutation_monitor_active: boolean;
  readonly detected_history_mutation: boolean;
}

export interface A3SandboxVerificationResult {
  readonly mount_allowed: boolean;
  readonly killed: boolean;
  readonly violations: ReadonlyArray<string>;
}

const FORBIDDEN_A3_SANDBOX_TOKENS = new Set([
  'allow-same-origin',
  'allow-top-navigation',
  'allow-top-navigation-by-user-activation',
  'allow-modals',
]);

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verifies the A3 isolation contract before mounting or serving the on-page assistant (§10.3, §10.11).
 */
export function verifyA3SandboxContract(input: A3SandboxMountInput): A3SandboxVerificationResult {
  const violations: string[] = [];

  if (!input.host_origin || !input.sandbox_origin || input.host_origin === input.sandbox_origin) {
    violations.push('A3_CROSS_ORIGIN_REQUIRED: sandbox_origin must differ from host_origin');
  }

  for (const token of input.iframe_sandbox_tokens) {
    if (FORBIDDEN_A3_SANDBOX_TOKENS.has(token.trim().toLowerCase())) {
      violations.push(`A3_FORBIDDEN_SANDBOX_TOKEN: "${token}" violates A3 sandbox isolation`);
    }
  }

  if (!input.host_owns_close_control) {
    violations.push('A3_HOST_CLOSE_CONTROL_REQUIRED: host must own widget close button');
  }
  if (!input.host_owns_navigation) {
    violations.push('A3_HOST_NAVIGATION_REQUIRED: host must own navigation jumps');
  }
  if (!input.context_disclosable_only) {
    violations.push('A3_DISCLOSABLE_CONTEXT_ONLY: non-disclosable context payload forbidden');
  }
  if (input.contains_password_field) {
    violations.push('A3_PASSWORD_PAGE_FORBIDDEN: assistant must never mount on pages with password fields');
  }
  if (input.contains_payment_field) {
    violations.push('A3_PAYMENT_PAGE_FORBIDDEN: assistant must never mount on pages with payment fields');
  }
  if (input.page_category === 'checkout' || input.page_category === 'auth') {
    violations.push(`A3_SENSITIVE_PAGE_CATEGORY_FORBIDDEN: "${input.page_category}" pages disallow A3 mount`);
  }
  if (!constantTimeStringEqual(input.human_approved_bundle_hash, input.deployed_bundle_hash)) {
    violations.push('A3_BUNDLE_HASH_UNAPPROVED: deployed bundle hash does not match human-approved hash');
  }
  if (!input.history_mutation_monitor_active) {
    violations.push('A3_HISTORY_MONITOR_REQUIRED: history-mutation kill monitor must be active');
  }

  const killed = input.detected_history_mutation === true;
  if (killed) {
    violations.push('A3_HISTORY_MUTATION_KILLED: unexpected history mutation detected; widget unmounted');
  }

  return {
    mount_allowed: violations.length === 0 && !killed,
    killed,
    violations,
  };
}

// =========================================================================
// 5. Lexical Matching & 3-Tier Assistant Execution
// =========================================================================

function tokenize(text: string): string[] {
  const normalized = text.toLowerCase().trim();
  if (!normalized) return [];
  const words = normalized
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
  // Also emit character bigrams for CJK matching without external tokenizers
  const bigrams: string[] = [];
  const compact = normalized.replace(/\s+/g, '');
  if (compact.length >= 2) {
    for (let i = 0; i < compact.length - 1; i++) {
      bigrams.push(compact.slice(i, i + 2));
    }
  }
  return [...words, ...bigrams];
}

function rankMatchingSections(
  question: string,
  sections: ReadonlyArray<IndexedPageSection>
): ReadonlyArray<{ readonly section: IndexedPageSection; readonly overlap: number }> {
  const qTokens = new Set(tokenize(question));
  if (qTokens.size === 0) {
    return sections.map((section) => ({ section, overlap: 0 }));
  }

  return sections
    .map((section) => {
      const hay = `${section.heading} ${section.curated_questions.join(' ')} ${section.verbatim_text}`;
      const hayTokens = new Set(tokenize(hay));
      let matches = 0;
      for (const t of qTokens) {
        if (hayTokens.has(t)) matches += 1;
      }
      return {
        section,
        overlap: matches / qTokens.size,
      };
    })
    .sort((a, b) => {
      if (b.overlap !== a.overlap) return b.overlap - a.overlap;
      return a.section.sec_fp.localeCompare(b.section.sec_fp);
    });
}

function extractVerbatimSnippet(section: IndexedPageSection, maxChars = 240): {
  readonly snippet: string;
  readonly quote_start: number;
  readonly quote_end: number;
} {
  const text = section.verbatim_text.trim();
  if (text.length <= maxChars) {
    return { snippet: text, quote_start: 0, quote_end: text.length };
  }
  const slice = text.slice(0, maxChars);
  return { snippet: slice, quote_start: 0, quote_end: slice.length };
}

/**
 * Serves a 3-tier on-page assistant response enforcing A3 sandbox safety and
 * automatic Tier 3 -> Tier 2 fallback when faithfulness gates or citations fail.
 */
export function serveAssistantResponse(req: AssistantAnswerRequest): AssistantAnswerResponse {
  const sandboxCheck: A3SandboxVerificationResult = req.sandbox_state
    ? verifyA3SandboxContract(req.sandbox_state)
    : {
        mount_allowed: true,
        killed: false,
        violations: [],
      };

  if (!sandboxCheck.mount_allowed) {
    return {
      allowed: false,
      sandbox_check: sandboxCheck,
      requested_tier: req.requested_tier,
      served_tier: null,
      fallback_from_tier3: false,
      fallback_reason: sandboxCheck.violations.join('; '),
      ai_generated_label: false,
      evidence_level: 'observed',
      jump_options: [],
      extractive_snippet: null,
      generative_answer: null,
      citations: [],
      tier3_gate: null,
    };
  }

  const jumpOptions: Tier1JumpOption[] = [];
  for (const s of req.sections) {
    for (const q of s.curated_questions) {
      jumpOptions.push({
        question_label: q,
        target_sec_fp: s.sec_fp,
        target_body_fp: s.body_fp,
        target_heading: s.heading,
      });
    }
  }

  // Tier 1: curated question buttons -> jump directly to sec_fp
  if (req.requested_tier === 'tier1_question_jump') {
    return {
      allowed: true,
      sandbox_check: sandboxCheck,
      requested_tier: req.requested_tier,
      served_tier: 'tier1_question_jump',
      fallback_from_tier3: false,
      fallback_reason: null,
      ai_generated_label: false,
      evidence_level: 'observed',
      jump_options: jumpOptions,
      extractive_snippet: null,
      generative_answer: null,
      citations: req.sections.map((s) => ({
        page_id: s.page_id,
        sec_fp: s.sec_fp,
        body_fp: s.body_fp,
      })),
      tier3_gate: null,
    };
  }

  const question = req.user_question?.trim() ?? '';
  const ranked = rankMatchingSections(question, req.sections);
  const topSection = ranked[0]?.section ?? null;

  const buildTier2Response = (
    fallbackFromTier3: boolean,
    fallbackReason: string | null,
    tier3Gate: Tier3GateResult | null
  ): AssistantAnswerResponse => {
    if (!topSection) {
      return {
        allowed: true,
        sandbox_check: sandboxCheck,
        requested_tier: req.requested_tier,
        served_tier: 'tier1_question_jump',
        fallback_from_tier3: fallbackFromTier3,
        fallback_reason: fallbackReason ?? 'NO_INDEXED_SECTIONS',
        ai_generated_label: false,
        evidence_level: 'observed',
        jump_options: jumpOptions,
        extractive_snippet: null,
        generative_answer: null,
        citations: [],
        tier3_gate: tier3Gate,
      };
    }

    const extracted = extractVerbatimSnippet(topSection);
    return {
      allowed: true,
      sandbox_check: sandboxCheck,
      requested_tier: req.requested_tier,
      served_tier: 'tier2_extractive',
      fallback_from_tier3: fallbackFromTier3,
      fallback_reason: fallbackReason,
      ai_generated_label: false,
      evidence_level: 'observed',
      jump_options: jumpOptions,
      extractive_snippet: extracted.snippet,
      generative_answer: null,
      citations: [
        {
          page_id: topSection.page_id,
          sec_fp: topSection.sec_fp,
          body_fp: topSection.body_fp,
          quote_start: extracted.quote_start,
          quote_end: extracted.quote_end,
        },
      ],
      tier3_gate: tier3Gate,
    };
  };

  if (req.requested_tier === 'tier2_extractive') {
    return buildTier2Response(false, null, null);
  }

  // Tier 3: Strictly gated by >= 200 human-labeled questions & Clopper-Pearson LCB >= owner floor
  const gateResult = evaluateTier3FaithfulnessGate(req.tier3_evaluation);
  if (!gateResult.eligible) {
    return buildTier2Response(
      true,
      `TIER3_FAITHFULNESS_GATE_UNMET: ${gateResult.unmet_gates.map((g) => g.id).join(', ')}`,
      gateResult
    );
  }

  if (!req.generateTier3 || !question) {
    return buildTier2Response(
      true,
      'TIER3_GENERATOR_UNAVAILABLE_OR_EMPTY_QUESTION',
      gateResult
    );
  }

  const groundedSections = ranked.slice(0, 3).map((r) => r.section);
  const generated = req.generateTier3({
    question,
    grounded_sections: groundedSections,
  });

  const sectionByFp = new Map(req.sections.map((s) => [s.sec_fp, s]));
  const verifiedCitations: AssistantSectionCitation[] = [];
  for (const fp of generated.cited_sec_fps) {
    const matched = sectionByFp.get(fp);
    if (matched) {
      verifiedCitations.push({
        page_id: matched.page_id,
        sec_fp: matched.sec_fp,
        body_fp: matched.body_fp,
      });
    }
  }

  // Never serve uncited generative output -> fall back to Tier 2 extractive
  if (!generated.answer_text.trim() || verifiedCitations.length === 0) {
    return buildTier2Response(
      true,
      'TIER3_MISSING_VALID_SECTION_CITATIONS',
      gateResult
    );
  }

  return {
    allowed: true,
    sandbox_check: sandboxCheck,
    requested_tier: req.requested_tier,
    served_tier: 'tier3_generative_cited',
    fallback_from_tier3: false,
    fallback_reason: null,
    ai_generated_label: true,
    evidence_level: 'inferred',
    jump_options: jumpOptions,
    extractive_snippet: null,
    generative_answer: generated.answer_text.trim(),
    citations: verifiedCitations,
    tier3_gate: gateResult,
  };
}

// =========================================================================
// 6. 4-F MlModelRegistry Challenger Registration
// =========================================================================

export function registerAssistantChallengers(
  registry: MlModelRegistry,
  tenantScope: string,
  nowIso: string = new Date().toISOString()
): ModelRegistryEntry {
  const id = 'assistant_tier3_generative_cited_v1';
  const entry: ModelRegistryEntry = {
    model_version_id: id,
    model_family: 'assistant_tier3_generative',
    tenant_scope: tenantScope,
    artifact_sha256: sha256Hex(`challenger:${id}:${tenantScope}`),
    abi_version: 1,
    feature_set_version: 'page_sections_sec_fp_v1',
    label_contract_version: 'human_labeled_faithfulness_v1',
    dataset_id: 'pending_site_200_human_labeled_questions',
    deletion_generation: registry.getDeletionGeneration(),
    code_version: 'wave6_6d_v1',
    runtime_env: 'server_llm_cited',
    seed: 603,
    license_bundle: {
      license_id: 'Proprietary-UGOKI-LINK',
      notice_text:
        'UGOKI LINK v2 Tier 3 cited generative assistant challenger (gated by >=200 human-labeled questions & Clopper-Pearson 95% LCB >= owner floor)',
      distribution_scope: 'server_only',
    },
    created_at_iso: nowIso,
    status: 'challenger',
    contributing_subject_ids: [],
  };
  return registry.registerModelVersion(entry);
}
