/**
 * UGOKI LINK v2 — Pre-LLM "Aggregation Loophole" Filter, External/Jev Provider Ban,
 * Pre-Execution Guard, Complementary Secondary Suppression, Window/Cohort Linear-Combination
 * Differencing Guard & Numeric Grounding Verifier (§11.11.11)
 */

import { inspectSqlAst, tokenizeSql } from '@/lib/link/isolation';
import type { ConsentMode } from '@/packages/contract/schema';
import {
  PUBLIC_AGGREGATE_VIEWS,
  READ_ONLY_ASK_TOOLS,
  type AggregateQueryRow,
  type AskPlannerProvider,
  type GroundedNumericCitation,
  type PreLlmFilterVerdict,
  type PublicAggregateViewName,
  type ReadOnlyAskToolName,
} from './types';

// =========================================================================
// 1. Strict Ban on External Models & Jev (§11.11.11 / §8.12)
// =========================================================================

const FORBIDDEN_EXTERNAL_PROVIDER_RE =
  /\b(openai|gpt-|anthropic|claude|google|gemini|jev|bedrock|vertex|azure|cohere|mistral-cloud|deepseek-api|perplexity)\b/i;

export class ForbiddenExternalProviderError extends Error {
  public readonly providerId: string;
  constructor(providerId: string, reason: string) {
    super(`POST /v1/ask forbids external models and Jev: ${providerId} (${reason})`);
    this.name = 'ForbiddenExternalProviderError';
    this.providerId = providerId;
  }
}

export function assertSelfHostedProviderOnly(provider: AskPlannerProvider): void {
  if (provider.hosting !== 'self_hosted_local' && provider.hosting !== 'deterministic_baseline') {
    throw new ForbiddenExternalProviderError(
      provider.providerId,
      `hosting="${provider.hosting}" is prohibited; only self_hosted_local or deterministic_baseline allowed`
    );
  }
  if (
    FORBIDDEN_EXTERNAL_PROVIDER_RE.test(provider.providerId) ||
    FORBIDDEN_EXTERNAL_PROVIDER_RE.test(provider.modelName)
  ) {
    throw new ForbiddenExternalProviderError(
      provider.providerId,
      `provider/model name "${provider.modelName}" matches banned external cloud or Jev identifier`
    );
  }
}

// =========================================================================
// 2. Column, Metric & Public View Allowlists (Blocks Identifiers, Free Text, Raw SQL Concat)
// =========================================================================

const PUBLIC_VIEW_SET: ReadonlySet<string> = new Set(PUBLIC_AGGREGATE_VIEWS);
const READ_ONLY_TOOL_SET: ReadonlySet<string> = new Set(READ_ONLY_ASK_TOOLS);

export const ALLOWED_METRICS_BY_PUBLIC_VIEW: Readonly<
  Record<PublicAggregateViewName, ReadonlySet<string>>
> = Object.freeze({
  v_pub_site_daily: new Set(['page_views', 'conversions', 'cvr', 'avg_focal_dwell_ms']),
  v_pub_page_daily: new Set(['page_views', 'conversions', 'avg_focal_dwell_ms']),
  v_pub_section_daily: new Set(['reach_rate', 'avg_focal_dwell_ms']),
  v_pub_segment_agg: new Set(['page_views', 'conversions', 'cvr']),
  v_pub_funnel_agg: new Set(['sessions', 'step_conversion_rate']),
  v_pub_experiment_summary: new Set(['lift_estimate']),
  v_pub_ai_actor_daily: new Set(['requests']),
});

export const ALLOWED_COLUMNS_BY_PUBLIC_VIEW: Readonly<
  Record<PublicAggregateViewName, ReadonlySet<string>>
> = Object.freeze({
  v_pub_site_daily: new Set([
    'day_local',
    'page_views',
    'conversions',
    'cvr',
    'avg_focal_dwell_ms',
  ]),
  v_pub_page_daily: new Set([
    'day_local',
    'page_id',
    'page_views',
    'conversions',
    'avg_focal_dwell_ms',
  ]),
  v_pub_section_daily: new Set([
    'day_local',
    'page_id',
    'sec_fp',
    'reach_rate',
    'avg_focal_dwell_ms',
  ]),
  v_pub_segment_agg: new Set(['day_local', 'segment_id', 'page_views', 'conversions', 'cvr']),
  v_pub_funnel_agg: new Set(['day_local', 'funnel_step', 'sessions', 'step_conversion_rate']),
  v_pub_experiment_summary: new Set(['day_local', 'experiment_id', 'lift_estimate']),
  v_pub_ai_actor_daily: new Set(['day_local', 'actor_class', 'requests']),
});

const FORBIDDEN_IDENTIFIER_COLUMNS: ReadonlySet<string> = new Set([
  'visitor_id',
  'user_id',
  'external_id',
  'ga_client_id',
  'session_id',
  'pv_id',
  'email',
  'phone',
  'ip',
  'client_ip',
  'ip_hash',
  'cookie_id',
  'member_id',
  'account_email',
]);

const FORBIDDEN_FREE_TEXT_COLUMNS: ReadonlySet<string> = new Set([
  'click_text',
  'anchor_text',
  'element_text',
  'page_content',
  'section_text',
  'raw_ua',
  'user_agent',
  'referrer_raw',
  'form_value',
  'input_value',
  'search_term',
  'site_search_term',
  'utm_raw',
  'free_text',
  'comment_body',
]);

export const ASK_MIN_CELL_K = 10;
export const ASK_MIN_WINDOW_DIFF_DAYS = 7;
export const ASK_MAX_OVERLAPPING_WINDOWS_PER_SCOPE = 8;

const MS_PER_DAY = 86_400_000;
const EPS = 1e-9;

// =========================================================================
// 3. Elementary-Atom RREF Linear-Combination & Window/Cohort Differencing Guard
// =========================================================================

function computeRref(matrix: ReadonlyArray<ReadonlyArray<number>>): number[][] {
  const rows = matrix.map((r) => [...r]);
  const numRows = rows.length;
  const numCols = numRows > 0 ? rows[0].length : 0;
  let lead = 0;

  for (let r = 0; r < numRows; r++) {
    if (lead >= numCols) break;
    let pivot = r;
    let maxAbs = Math.abs(rows[pivot][lead]);
    for (let i = r + 1; i < numRows; i++) {
      const cand = Math.abs(rows[i][lead]);
      if (cand > maxAbs) {
        maxAbs = cand;
        pivot = i;
      }
    }
    if (maxAbs <= EPS) {
      lead += 1;
      r -= 1;
      continue;
    }
    if (pivot !== r) {
      const tmp = rows[r];
      rows[r] = rows[pivot];
      rows[pivot] = tmp;
    }
    const div = rows[r][lead];
    for (let j = 0; j < numCols; j++) {
      rows[r][j] /= div;
    }
    for (let i = 0; i < numRows; i++) {
      if (i !== r) {
        const factor = rows[i][lead];
        if (Math.abs(factor) > EPS) {
          for (let j = 0; j < numCols; j++) {
            rows[i][j] -= factor * rows[r][j];
          }
        }
      }
    }
    lead += 1;
  }

  return rows;
}

function vectorWeightedSupport(vec: ReadonlyArray<number>, weights: ReadonlyArray<number>): number {
  let total = 0;
  for (let j = 0; j < vec.length; j++) {
    if (Math.abs(vec[j]) > EPS) {
      total += weights[j];
    }
  }
  return total;
}

function normalizedSignPattern(vec: ReadonlyArray<number>): string {
  let firstSign = 1;
  for (const v of vec) {
    if (Math.abs(v) > EPS) {
      firstSign = v < 0 ? -1 : 1;
      break;
    }
  }
  return vec
    .map((v) => {
      const scaled = v * firstSign;
      return Math.abs(scaled) <= EPS ? '0' : scaled.toFixed(6);
    })
    .join(',');
}

/**
 * Evaluates whether adding `candidateRows` (atomically as a batch) to `priorRows` over
 * disjoint elementary atoms (`atomWeights`) creates ANY pairwise difference or multi-query
 * RREF linear combination with non-zero weighted support strictly below `minSupport`.
 */
function checkBatchLinearCombinationSupport(
  priorRows: ReadonlyArray<ReadonlyArray<number>>,
  candidateRows: ReadonlyArray<ReadonlyArray<number>>,
  atomWeights: ReadonlyArray<number>,
  minSupport: number
): { readonly allowed: boolean; readonly minObservedSupport?: number } {
  if (candidateRows.length === 0) {
    return { allowed: true };
  }

  const checkPair = (
    a: ReadonlyArray<number>,
    b: ReadonlyArray<number>
  ): { readonly allowed: boolean; readonly minObservedSupport?: number } => {
    let onlyInA = 0;
    let onlyInB = 0;
    for (let j = 0; j < atomWeights.length; j++) {
      const aHas = Math.abs(a[j]) > EPS;
      const bHas = Math.abs(b[j]) > EPS;
      if (aHas && !bHas) onlyInA += atomWeights[j];
      if (bHas && !aHas) onlyInB += atomWeights[j];
    }
    const symDiff = onlyInA + onlyInB;
    if (
      (symDiff > EPS && symDiff < minSupport - EPS) ||
      (onlyInA > EPS && onlyInA < minSupport - EPS && onlyInB <= EPS) ||
      (onlyInB > EPS && onlyInB < minSupport - EPS && onlyInA <= EPS)
    ) {
      const smallest = Math.min(
        symDiff,
        onlyInA > EPS ? onlyInA : symDiff,
        onlyInB > EPS ? onlyInB : symDiff
      );
      return { allowed: false, minObservedSupport: smallest };
    }
    return { allowed: true };
  };

  // 1. Pairwise symmetric and one-sided difference check (candidate vs prior, and candidate vs candidate)
  for (let i = 0; i < candidateRows.length; i++) {
    const cand = candidateRows[i];
    for (const prev of priorRows) {
      const res = checkPair(prev, cand);
      if (!res.allowed) return res;
    }
    for (let j = i + 1; j < candidateRows.length; j++) {
      const res = checkPair(cand, candidateRows[j]);
      if (!res.allowed) return res;
    }
  }

  // Record standalone prior patterns that were already individually accepted so we only
  // penalize newly formed combinations when a standalone prior query had narrow support.
  const standalonePriorSmallPatterns = new Set<string>();
  for (const prev of priorRows) {
    const supp = vectorWeightedSupport(prev, atomWeights);
    if (supp > EPS && supp < minSupport - EPS) {
      standalonePriorSmallPatterns.add(normalizedSignPattern(prev));
    }
  }

  // 2. Multi-query Gaussian elimination (RREF) across all prior + candidate rows together
  const combinedMatrix = [...priorRows, ...candidateRows];
  const rref = computeRref(combinedMatrix);
  const nonZeroBasis = rref.filter((r) => vectorWeightedSupport(r, atomWeights) > EPS);

  for (const row of nonZeroBasis) {
    const supp = vectorWeightedSupport(row, atomWeights);
    if (supp > EPS && supp < minSupport - EPS) {
      if (!standalonePriorSmallPatterns.has(normalizedSignPattern(row))) {
        return { allowed: false, minObservedSupport: supp };
      }
    }
  }

  // Also check 2-basis-row combinations R_a +/- R_b in RREF space
  for (let a = 0; a < nonZeroBasis.length; a++) {
    for (let b = a + 1; b < nonZeroBasis.length; b++) {
      const diff = nonZeroBasis[a].map((v, j) => v - nonZeroBasis[b][j]);
      const sum = nonZeroBasis[a].map((v, j) => v + nonZeroBasis[b][j]);
      for (const comb of [diff, sum]) {
        const supp = vectorWeightedSupport(comb, atomWeights);
        if (supp > EPS && supp < minSupport - EPS) {
          if (!standalonePriorSmallPatterns.has(normalizedSignPattern(comb))) {
            return { allowed: false, minObservedSupport: supp };
          }
        }
      }
    }
  }

  // 3. Exact small-atom subspace check: eliminate largeCols first on [M_large | M_small]
  //    so rows >= largeRank form an exact basis of combinations supported solely on small atoms.
  const smallCols: number[] = [];
  const largeCols: number[] = [];
  for (let j = 0; j < atomWeights.length; j++) {
    if (atomWeights[j] < minSupport - EPS) {
      smallCols.push(j);
    } else {
      largeCols.push(j);
    }
  }
  if (smallCols.length > 0 && largeCols.length > 0) {
    const orderedCols = [...largeCols, ...smallCols];
    const orderedWeights = orderedCols.map((c) => atomWeights[c]);
    const orderedMatrix = combinedMatrix.map((row) => orderedCols.map((c) => row[c]));
    const largeOnlyMatrix = combinedMatrix.map((row) => largeCols.map((c) => row[c]));
    const largeRank = computeRref(largeOnlyMatrix).filter(
      (r) => r.some((v) => Math.abs(v) > EPS)
    ).length;
    const subRref = computeRref(orderedMatrix).filter(
      (r) => r.some((v) => Math.abs(v) > EPS)
    );
    for (let i = largeRank; i < subRref.length; i++) {
      const supp = vectorWeightedSupport(subRref[i], orderedWeights);
      if (supp > EPS && supp < minSupport - EPS) {
        const origVec = new Array<number>(atomWeights.length).fill(0);
        for (let k = 0; k < orderedCols.length; k++) {
          origVec[orderedCols[k]] = subRref[i][k];
        }
        if (!standalonePriorSmallPatterns.has(normalizedSignPattern(origVec))) {
          return { allowed: false, minObservedSupport: supp };
        }
      }
    }
  }

  return { allowed: true };
}

function checkLinearCombinationSupport(
  priorRows: ReadonlyArray<ReadonlyArray<number>>,
  candidateRow: ReadonlyArray<number>,
  atomWeights: ReadonlyArray<number>,
  minSupport: number
): { readonly allowed: boolean; readonly minObservedSupport?: number } {
  return checkBatchLinearCombinationSupport(priorRows, [candidateRow], atomWeights, minSupport);
}

interface CohortHistoryEntry {
  readonly filterSignature: string;
  readonly memberSet: ReadonlySet<string>;
}

interface WindowHistoryEntry {
  readonly startMs: number;
  readonly endMs: number;
}

export class DifferencingGuard {
  /** Key: `${tenantId}:${siteId}:${permissionEpoch}` */
  private readonly history = new Map<string, CohortHistoryEntry[]>();
  /** Key: `${sessionKey}|${viewName}|${metricName}|${predicateKey}` */
  private readonly windowHistory = new Map<string, WindowHistoryEntry[]>();
  private readonly minCellK: number;
  private readonly minWindowDiffDays: number;
  private readonly maxOverlappingWindowsPerScope: number;

  constructor(
    minCellK = ASK_MIN_CELL_K,
    options?: {
      readonly minWindowDiffDays?: number;
      readonly maxOverlappingWindowsPerScope?: number;
    }
  ) {
    this.minCellK = minCellK;
    this.minWindowDiffDays = options?.minWindowDiffDays ?? ASK_MIN_WINDOW_DIFF_DAYS;
    this.maxOverlappingWindowsPerScope =
      options?.maxOverlappingWindowsPerScope ?? ASK_MAX_OVERLAPPING_WINDOWS_PER_SCOPE;
  }

  /**
   * Atomically evaluates a batch of disclosed cohort constraint vectors (e.g. every individually
   * disclosed GROUP BY row PLUS the disclosed total row) against the session's RREF history.
   * When `options.commit !== false`, commits ALL new equations to history ONLY if the entire
   * batch passes; if ANY equation or multi-query linear combination isolates `1..(k-1)` individuals,
   * rejects and commits NOTHING.
   */
  public checkAndRecordBatch(
    sessionKey: string,
    entries: ReadonlyArray<{
      readonly filterSignature: string;
      readonly cohortMemberIds: ReadonlyArray<string>;
    }>,
    options?: { readonly commit?: boolean }
  ): { readonly allowed: boolean; readonly isolatedCount?: number } {
    const shouldCommit = options?.commit ?? true;
    const priorList = this.history.get(sessionKey) ?? [];

    const setsEqual = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
      if (a.size !== b.size) return false;
      for (const id of a) {
        if (!b.has(id)) return false;
      }
      return true;
    };

    // Deduplicate against prior committed sets AND within the batch itself
    const newEntries: CohortHistoryEntry[] = [];
    for (const entry of entries) {
      const currSet = new Set(entry.cohortMemberIds);
      if (currSet.size === 0) continue;

      if (currSet.size < this.minCellK) {
        return {
          allowed: false,
          isolatedCount: currSet.size,
        };
      }

      const alreadyInPrior = priorList.some((p) => setsEqual(p.memberSet, currSet));
      if (alreadyInPrior) continue;

      const alreadyInBatch = newEntries.some((n) => setsEqual(n.memberSet, currSet));
      if (alreadyInBatch) continue;

      newEntries.push({ filterSignature: entry.filterSignature, memberSet: currSet });
    }

    if (newEntries.length === 0) {
      return { allowed: true };
    }

    if (priorList.length > 0 || newEntries.length > 1) {
      const allSets: ReadonlyArray<ReadonlySet<string>> = [
        ...priorList.map((p) => p.memberSet),
        ...newEntries.map((n) => n.memberSet),
      ];
      const universe = new Set<string>();
      for (const s of allSets) {
        for (const id of s) universe.add(id);
      }

      const atomCounts = new Map<string, { weight: number; membership: number[] }>();
      for (const id of universe) {
        const membership = allSets.map((s) => (s.has(id) ? 1 : 0));
        const key = membership.join('');
        const existing = atomCounts.get(key);
        if (existing) {
          existing.weight += 1;
        } else {
          atomCounts.set(key, { weight: 1, membership });
        }
      }

      const atoms = Array.from(atomCounts.values());
      const atomWeights = atoms.map((a) => a.weight);
      const priorRows = priorList.map((_, rowIdx) => atoms.map((a) => a.membership[rowIdx]));
      const candidateRows = newEntries.map((_, idx) =>
        atoms.map((a) => a.membership[priorList.length + idx])
      );

      const check = checkBatchLinearCombinationSupport(
        priorRows,
        candidateRows,
        atomWeights,
        this.minCellK
      );
      if (!check.allowed) {
        // Atomic rollback: do NOT commit any entry from this batch!
        return {
          allowed: false,
          isolatedCount: Math.max(1, Math.round(check.minObservedSupport ?? 1)),
        };
      }
    }

    // Entire batch passed: commit all new equations atomically only if requested
    if (shouldCommit) {
      this.history.set(sessionKey, [...priorList, ...newEntries]);
    }
    return { allowed: true };
  }

  public hasCohortHistory(sessionKey: string): boolean {
    return (this.history.get(sessionKey)?.length ?? 0) > 0;
  }

  public getCohortHistoryLength(sessionKey: string): number {
    return this.history.get(sessionKey)?.length ?? 0;
  }

  public getWindowHistoryLength(sessionKey: string): number {
    const prefix = `${sessionKey}|`;
    let total = 0;
    for (const [k, list] of this.windowHistory.entries()) {
      if (k.startsWith(prefix)) {
        total += list.length;
      }
    }
    return total;
  }

  /**
   * Checks whether the new query's cohort differs from ANY prior query or multi-query
   * linear combination in the same `(tenantId, siteId, permissionEpoch)` session by
   * `1..(k-1)` individuals (blocks pairwise differencing AND 4-query RREF linear combinations).
   */
  public checkAndRecord(
    sessionKey: string,
    filterSignature: string,
    cohortMemberIds: ReadonlyArray<string>,
    options?: { readonly commit?: boolean }
  ): { readonly allowed: boolean; readonly isolatedCount?: number } {
    return this.checkAndRecordBatch(sessionKey, [{ filterSignature, cohortMemberIds }], options);
  }

  /**
   * Pre-execution time-window differencing & multi-query linear-combination tracker.
   * Blocks 1-day window shifts (`[D1..D28]` vs `[D2..D29]`), 1-day shrinks (`[D1..D28]` vs `[D1..D27]`),
   * 4-query RREF linear combinations isolating `< minWindowDiffDays` days, and excessive overlapping
   * window probing BEFORE any database query executes.
   */
  public checkAndRecordWindow(
    params: {
      readonly sessionKey: string;
      readonly viewName: string;
      readonly metricName: string;
      readonly predicateKey: string;
      readonly windowStart: string;
      readonly windowEnd: string;
    },
    options?: { readonly commit?: boolean }
  ): { readonly allowed: boolean; readonly isolatedDays?: number; readonly reason?: string } {
    const shouldCommit = options?.commit ?? true;
    const startMs = Date.parse(params.windowStart);
    const endMs = Date.parse(params.windowEnd);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
      return {
        allowed: false,
        reason: 'disclosure_blocked_invalid_window',
      };
    }

    // Treat single-instant or date-equal bounds as at least 1ms positive interval; normalize
    // calendar date strings or timestamps consistently on millisecond half-open [startMs, effectiveEndMs).
    const effectiveEndMs = endMs === startMs ? startMs + MS_PER_DAY : endMs;
    const scopeKey = `${params.sessionKey}|${params.viewName}|${params.metricName}|${params.predicateKey}`;
    const priorWindows = this.windowHistory.get(scopeKey) ?? [];

    // Exact repeat of an already-accepted window is idempotent
    for (const w of priorWindows) {
      if (w.startMs === startMs && w.endMs === effectiveEndMs) {
        return { allowed: true };
      }
    }

    // Find the connected component of windows overlapping or touching [startMs, effectiveEndMs)
    const connected: WindowHistoryEntry[] = [];
    let compMin = startMs;
    let compMax = effectiveEndMs;
    const remaining = [...priorWindows];
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = remaining.length - 1; i >= 0; i--) {
        const w = remaining[i];
        // Touching or overlapping intervals can combine in linear equations (e.g. [1,11) + [11,21) = [1,21))
        if (w.startMs <= compMax && w.endMs >= compMin) {
          connected.push(w);
          compMin = Math.min(compMin, w.startMs);
          compMax = Math.max(compMax, w.endMs);
          remaining.splice(i, 1);
          changed = true;
        }
      }
    }

    if (connected.length > 0) {
      if (connected.length + 1 > this.maxOverlappingWindowsPerScope) {
        return {
          allowed: false,
          reason: 'disclosure_blocked_differencing',
        };
      }

      // Build elementary disjoint sub-intervals from sorted unique coordinates
      const coordSet = new Set<number>([startMs, effectiveEndMs]);
      for (const w of connected) {
        coordSet.add(w.startMs);
        coordSet.add(w.endMs);
      }
      const coords = Array.from(coordSet).sort((a, b) => a - b);
      const atomWeightsDays: number[] = [];
      const intervals: Array<{ a: number; b: number }> = [];
      for (let idx = 0; idx < coords.length - 1; idx++) {
        const a = coords[idx];
        const b = coords[idx + 1];
        if (b > a) {
          intervals.push({ a, b });
          atomWeightsDays.push((b - a) / MS_PER_DAY);
        }
      }

      const priorRows = connected.map((w) =>
        intervals.map((iv) => (w.startMs <= iv.a && w.endMs >= iv.b ? 1 : 0))
      );
      const candidateRow = intervals.map((iv) =>
        startMs <= iv.a && effectiveEndMs >= iv.b ? 1 : 0
      );

      const check = checkLinearCombinationSupport(
        priorRows,
        candidateRow,
        atomWeightsDays,
        this.minWindowDiffDays
      );
      if (!check.allowed) {
        const days = Number((check.minObservedSupport ?? 0).toFixed(4));
        return {
          allowed: false,
          isolatedDays: days,
          reason: 'disclosure_blocked_differencing',
        };
      }
    }

    if (shouldCommit) {
      this.windowHistory.set(scopeKey, [...priorWindows, { startMs, endMs: effectiveEndMs }]);
    }
    return { allowed: true };
  }

  public clearSession(sessionKey: string): void {
    this.history.delete(sessionKey);
    const prefix = `${sessionKey}|`;
    for (const k of Array.from(this.windowHistory.keys())) {
      if (k.startsWith(prefix)) {
        this.windowHistory.delete(k);
      }
    }
  }
}

// =========================================================================
// 4. SQL Table, Metric & Parameter Binding Verification (Zero Raw Concat)
// =========================================================================

const FORBIDDEN_SQL_CONSTRUCT_RE =
  /(?:--|\/\*|\*\/|;|\bUNION\b|\bJOIN\b|\bINTO\s+OUTFILE\b|\b(?:URL|REMOTE|REMOTE_SECURE|FILE|S3|HDFS|JDBC|ODBC|MYSQL|POSTGRESQL|CLUSTER| VALUES)\s*\(|\(\s*SELECT\b)/i;

const SAFE_AGG_EXPR_RE = /^(?:sum|avg|min|max|count)\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\)$/i;
const SAFE_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function verifyPublicViewSqlAndMetrics(params: {
  readonly viewName: PublicAggregateViewName;
  readonly sql: string;
  readonly metricName?: string;
}): {
  readonly valid: boolean;
  readonly blockedCode?: 'NON_WHITELISTED_VIEW' | 'NON_ALLOWED_METRIC' | 'SQL_AST_VIOLATION';
  readonly reason?: string;
} {
  const allowedMetrics = ALLOWED_METRICS_BY_PUBLIC_VIEW[params.viewName];
  const allowedColumns = ALLOWED_COLUMNS_BY_PUBLIC_VIEW[params.viewName];

  if (params.metricName !== undefined && !allowedMetrics.has(params.metricName)) {
    return {
      valid: false,
      blockedCode: 'NON_ALLOWED_METRIC',
      reason: `Metric "${params.metricName}" is not in the allowlist for view "${params.viewName}"`,
    };
  }

  if (FORBIDDEN_SQL_CONSTRUCT_RE.test(params.sql)) {
    return {
      valid: false,
      blockedCode: 'SQL_AST_VIOLATION',
      reason: 'SQL contains forbidden comment, multi-statement, JOIN, UNION, table function, or subquery',
    };
  }

  // Extract FROM target before WHERE / GROUP BY / ORDER BY / LIMIT
  const fromMatch = /\bFROM\s+([^\s,;()]+)(?:\s+(?:WHERE|GROUP|ORDER|LIMIT)\b|\s*$)/i.exec(params.sql);
  if (!fromMatch) {
    return {
      valid: false,
      blockedCode: 'SQL_AST_VIOLATION',
      reason: 'SQL must contain a single explicit FROM <public_view> clause',
    };
  }

  const sqlTable = fromMatch[1].trim();
  if (!PUBLIC_VIEW_SET.has(sqlTable)) {
    return {
      valid: false,
      blockedCode: 'NON_WHITELISTED_VIEW',
      reason: `SQL FROM table "${sqlTable}" is not an allowlisted public aggregate view`,
    };
  }
  if (sqlTable !== params.viewName) {
    return {
      valid: false,
      blockedCode: 'SQL_AST_VIOLATION',
      reason: `SQL FROM table "${sqlTable}" does not match declared plan view "${params.viewName}"`,
    };
  }

  // Require bound {tenant_id:String} parameter (never string-interpolated tenant literals)
  if (!/\btenant_id\s*=\s*\{tenant_id:String\}/i.test(params.sql)) {
    return {
      valid: false,
      blockedCode: 'SQL_AST_VIOLATION',
      reason: 'SQL must bind tenant_id via parameterized {tenant_id:String}',
    };
  }

  // Inspect SELECT projection list to ensure zero raw metric expressions or non-allowlisted columns
  const selectMatch = /^\s*SELECT\s+([\s\S]+?)\s+FROM\s+/i.exec(params.sql);
  if (!selectMatch) {
    return {
      valid: false,
      blockedCode: 'SQL_AST_VIOLATION',
      reason: 'Unable to parse SELECT projection list',
    };
  }

  const projections = selectMatch[1].split(',').map((s) => s.trim());
  if (projections.length === 0) {
    return {
      valid: false,
      blockedCode: 'SQL_AST_VIOLATION',
      reason: 'Empty SELECT projection list',
    };
  }

  for (const rawItem of projections) {
    const withoutAlias = rawItem.replace(/\s+AS\s+[a-zA-Z_][a-zA-Z0-9_]*$/i, '').trim();
    const aggMatch = SAFE_AGG_EXPR_RE.exec(withoutAlias);
    if (aggMatch) {
      const innerCol = aggMatch[1].toLowerCase();
      if (FORBIDDEN_IDENTIFIER_COLUMNS.has(innerCol) || FORBIDDEN_FREE_TEXT_COLUMNS.has(innerCol)) {
        return {
          valid: false,
          blockedCode: 'NON_ALLOWED_METRIC',
          reason: `Aggregate references forbidden column "${innerCol}"`,
        };
      }
      if (!allowedMetrics.has(innerCol)) {
        return {
          valid: false,
          blockedCode: 'NON_ALLOWED_METRIC',
          reason: `Aggregate metric "${innerCol}" is not allowlisted on view "${params.viewName}"`,
        };
      }
      continue;
    }

    if (SAFE_IDENT_RE.test(withoutAlias)) {
      const colLower = withoutAlias.toLowerCase();
      if (!allowedColumns.has(colLower)) {
        return {
          valid: false,
          blockedCode: 'NON_ALLOWED_METRIC',
          reason: `Selected column "${withoutAlias}" is not allowlisted on view "${params.viewName}"`,
        };
      }
      continue;
    }

    return {
      valid: false,
      blockedCode: 'NON_ALLOWED_METRIC',
      reason: `Raw SQL expression "${withoutAlias}" is prohibited in SELECT list (use allowlisted metric identifiers only)`,
    };
  }

  return { valid: true };
}

function hasSqlGroupBy(sql: string): boolean {
  const { tokens } = tokenizeSql(sql);
  return tokens.some((token, i) => {
    const next = tokens[i + 1];
    return token.kind === 'IDENT' && !token.quoted && token.lower === 'group' &&
      next?.kind === 'IDENT' && !next.quoted && next.lower === 'by';
  });
}

export function extractPredicateScopeKey(filterSignature: string): string {
  // Preserve explicit cohort predicates (e.g. `cohort:diff_pair_0_all`), while grouping
  // paraphrased natural-language questions (`q:<hash>`) into canonical 'ALL' so reworded
  // questions with shifted time windows cannot evade the window differencing guard.
  if (filterSignature.startsWith('cohort:')) {
    return filterSignature;
  }
  return 'ALL';
}

// =========================================================================
// 5. Pre-Execution Gate (Runs STRICTLY BEFORE DB Execution!)
// =========================================================================

export function validateAskQueryBeforeExecution(params: {
  readonly siteConsentMode: ConsentMode;
  readonly toolName?: ReadOnlyAskToolName | string;
  readonly viewName: string;
  readonly metricName: string;
  readonly sql: string;
  readonly requestedColumns: ReadonlyArray<string>;
  readonly groupByColumns: ReadonlyArray<string>;
  readonly sessionKey: string;
  readonly filterSignature: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly predeclaredCohortMemberIds?: ReadonlyArray<string>;
  readonly differencingGuard: DifferencingGuard;
}): PreLlmFilterVerdict {
  // 1. Consent & purpose enforcement independent of planner
  if (params.siteConsentMode === 'off') {
    return {
      allowed: false,
      blockedCode: 'CONSENT_OFF_BLOCKED',
      reason: 'Site consent mode is "off"; querying behaviour aggregates is prohibited before DB execution',
      safeRows: [],
      suppressedCount: 0,
    };
  }

  if (params.toolName !== undefined && !READ_ONLY_TOOL_SET.has(params.toolName)) {
    return {
      allowed: false,
      blockedCode: 'NON_READ_ONLY_TOOL',
      reason: `Planner tool "${params.toolName}" is not in the physical read-only allowlist`,
      safeRows: [],
      suppressedCount: 0,
    };
  }

  // 2. Public aggregate view whitelist check
  if (!PUBLIC_VIEW_SET.has(params.viewName)) {
    return {
      allowed: false,
      blockedCode: 'NON_WHITELISTED_VIEW',
      reason: `View "${params.viewName}" is not in the public read-only aggregate whitelist`,
      safeRows: [],
      suppressedCount: 0,
    };
  }

  const typedView = params.viewName as PublicAggregateViewName;

  // Funnel aggregates require at least `session` consent
  if (typedView === 'v_pub_funnel_agg' && params.siteConsentMode === 'cookieless') {
    return {
      allowed: false,
      blockedCode: 'CONSENT_PURPOSE_MISMATCH',
      reason: 'View "v_pub_funnel_agg" requires consent >= "session"; blocked under "cookieless" consent',
      safeRows: [],
      suppressedCount: 0,
    };
  }

  // 3. Column PII / free-text / allowlist check BEFORE execution
  const allowedCols = ALLOWED_COLUMNS_BY_PUBLIC_VIEW[typedView];
  const allCols = [...params.requestedColumns, ...params.groupByColumns].map((c) =>
    c.trim().toLowerCase()
  );
  for (const col of allCols) {
    if (FORBIDDEN_IDENTIFIER_COLUMNS.has(col)) {
      return {
        allowed: false,
        blockedCode: 'IDENTIFIER_COLUMN_BLOCKED',
        reason: `Identifier column "${col}" is strictly forbidden in /v1/ask queries and model context`,
        safeRows: [],
        suppressedCount: 0,
      };
    }
    if (FORBIDDEN_FREE_TEXT_COLUMNS.has(col)) {
      return {
        allowed: false,
        blockedCode: 'FREE_TEXT_COLUMN_BLOCKED',
        reason: `Free-text column "${col}" is strictly forbidden in /v1/ask queries and model context`,
        safeRows: [],
        suppressedCount: 0,
      };
    }
    if (!allowedCols.has(col)) {
      return {
        allowed: false,
        blockedCode: 'NON_ALLOWED_METRIC',
        reason: `Column "${col}" is not in the allowlisted schema for "${typedView}"`,
        safeRows: [],
        suppressedCount: 0,
      };
    }
  }

  // 4. Layer-A ClickHouse SQL AST + explicit FROM table & allowlisted metric verification
  const ast = inspectSqlAst(params.sql, { requireTenantFilter: true, requireTimeBound: true });
  if (!ast.valid) {
    return {
      allowed: false,
      blockedCode: 'SQL_AST_VIOLATION',
      reason: `Generated SQL failed AST lint: ${ast.violations.map((v) => v.code).join(', ')}`,
      safeRows: [],
      suppressedCount: 0,
    };
  }

  const sqlTableMetricCheck = verifyPublicViewSqlAndMetrics({
    viewName: typedView,
    sql: params.sql,
    metricName: params.metricName,
  });
  if (!sqlTableMetricCheck.valid) {
    return {
      allowed: false,
      blockedCode: sqlTableMetricCheck.blockedCode ?? 'SQL_AST_VIOLATION',
      reason: sqlTableMetricCheck.reason,
      safeRows: [],
      suppressedCount: 0,
    };
  }

  // 5. Pre-execution time-window differencing & multi-query linear combination check (DRY-RUN ONLY!)
  //    History is NOT mutated until post-query row checks pass and the entire Ask response is approved.
  const boundFilterSignature = `${params.filterSignature}|win:${params.windowStart}..${params.windowEnd}`;
  const windowCheck = params.differencingGuard.checkAndRecordWindow(
    {
      sessionKey: params.sessionKey,
      viewName: typedView,
      metricName: params.metricName,
      predicateKey: extractPredicateScopeKey(params.filterSignature),
      windowStart: params.windowStart,
      windowEnd: params.windowEnd,
    },
    { commit: false }
  );
  if (!windowCheck.allowed) {
    return {
      allowed: false,
      blockedCode: 'DIFFERENCING_ATTACK_BLOCKED',
      reason: 'disclosure_blocked_differencing',
      safeRows: [],
      suppressedCount: 0,
    };
  }

  // 6. Optional pre-declared cohort differencing check BEFORE execution (DRY-RUN ONLY!)
  //    Committed atomically with disclosed row + total equations ONLY after post-row approval.
  if (params.predeclaredCohortMemberIds && params.predeclaredCohortMemberIds.length > 0) {
    const cohortCheck = params.differencingGuard.checkAndRecord(
      params.sessionKey,
      boundFilterSignature,
      params.predeclaredCohortMemberIds,
      { commit: false }
    );
    if (!cohortCheck.allowed) {
      return {
        allowed: false,
        blockedCode: 'DIFFERENCING_ATTACK_BLOCKED',
        reason: 'disclosure_blocked_differencing',
        safeRows: [],
        suppressedCount: 0,
      };
    }
  }

  return {
    allowed: true,
    safeRows: [],
    suppressedCount: 0,
  };
}

// =========================================================================
// 6. Independent Pre-LLM Query + Result Filter (Includes Complementary Suppression)
// =========================================================================

export function filterQueryAndRowsBeforeLlm(params: {
  readonly viewName: string;
  readonly metricName?: string;
  readonly sql: string;
  readonly requestedColumns: ReadonlyArray<string>;
  readonly groupByColumns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<AggregateQueryRow>;
  readonly sessionKey: string;
  readonly filterSignature: string;
  readonly windowStart?: string;
  readonly windowEnd?: string;
  readonly skipWindowCheck?: boolean;
  readonly predeclaredCohortMemberIds?: ReadonlyArray<string>;
  readonly requireCohortMembership?: boolean;
  readonly requireMembershipForGroupedRows?: boolean;
  readonly deferCommit?: boolean;
  readonly differencingGuard: DifferencingGuard;
  readonly minCellK?: number;
}): PreLlmFilterVerdict {
  const minK = params.minCellK ?? ASK_MIN_CELL_K;

  // 1. Public aggregate view whitelist check
  if (!PUBLIC_VIEW_SET.has(params.viewName as PublicAggregateViewName)) {
    return {
      allowed: false,
      blockedCode: 'NON_WHITELISTED_VIEW',
      reason: 'disclosure_blocked_policy',
      safeRows: [],
      suppressedCount: 0,
    };
  }

  const typedView = params.viewName as PublicAggregateViewName;

  // 2. Column check: reject identifiers & free-text columns before execution/LLM
  const allCols = [...params.requestedColumns, ...params.groupByColumns].map((c) =>
    c.trim().toLowerCase()
  );
  for (const col of allCols) {
    if (FORBIDDEN_IDENTIFIER_COLUMNS.has(col)) {
      return {
        allowed: false,
        blockedCode: 'IDENTIFIER_COLUMN_BLOCKED',
        reason: 'disclosure_blocked_restricted_column',
        safeRows: [],
        suppressedCount: 0,
      };
    }
    if (FORBIDDEN_FREE_TEXT_COLUMNS.has(col)) {
      return {
        allowed: false,
        blockedCode: 'FREE_TEXT_COLUMN_BLOCKED',
        reason: 'disclosure_blocked_restricted_column',
        safeRows: [],
        suppressedCount: 0,
      };
    }
  }

  // 3. Layer-A ClickHouse SQL AST + FROM table & allowlisted metric verification
  const ast = inspectSqlAst(params.sql, { requireTenantFilter: true, requireTimeBound: true });
  if (!ast.valid) {
    return {
      allowed: false,
      blockedCode: 'SQL_AST_VIOLATION',
      reason: 'disclosure_blocked_policy',
      safeRows: [],
      suppressedCount: 0,
    };
  }

  const sqlTableMetricCheck = verifyPublicViewSqlAndMetrics({
    viewName: typedView,
    sql: params.sql,
    metricName: params.metricName,
  });
  if (!sqlTableMetricCheck.valid) {
    return {
      allowed: false,
      blockedCode: sqlTableMetricCheck.blockedCode ?? 'SQL_AST_VIOLATION',
      reason: 'disclosure_blocked_policy',
      safeRows: [],
      suppressedCount: 0,
    };
  }

  // 4. Optional time-window differencing check (DRY-RUN here; committed atomically ONLY upon full approval)
  const pendingWindowCheck =
    !params.skipWindowCheck && params.windowStart && params.windowEnd
      ? {
          sessionKey: params.sessionKey,
          viewName: typedView,
          metricName: params.metricName ?? 'default_metric',
          predicateKey: extractPredicateScopeKey(params.filterSignature),
          windowStart: params.windowStart,
          windowEnd: params.windowEnd,
        }
      : null;

  if (pendingWindowCheck) {
    const winCheck = params.differencingGuard.checkAndRecordWindow(pendingWindowCheck, {
      commit: false,
    });
    if (!winCheck.allowed) {
      return {
        allowed: false,
        blockedCode: 'DIFFERENCING_ATTACK_BLOCKED',
        reason: 'disclosure_blocked_differencing',
        safeRows: [],
        suppressedCount: params.rows.length,
      };
    }
  }

  // 5. Check row-level extra columns for accidental identifier/free-text leaks
  for (const row of params.rows) {
    if (row.extraColumns) {
      for (const k of Object.keys(row.extraColumns)) {
        const lower = k.toLowerCase();
        if (FORBIDDEN_IDENTIFIER_COLUMNS.has(lower)) {
          return {
            allowed: false,
            blockedCode: 'IDENTIFIER_COLUMN_BLOCKED',
            reason: 'disclosure_blocked_restricted_column',
            safeRows: [],
            suppressedCount: 0,
          };
        }
        if (FORBIDDEN_FREE_TEXT_COLUMNS.has(lower)) {
          return {
            allowed: false,
            blockedCode: 'FREE_TEXT_COLUMN_BLOCKED',
            reason: 'disclosure_blocked_restricted_column',
            safeRows: [],
            suppressedCount: 0,
          };
        }
      }
    }
  }

  // 6. Primary < k cell suppression + mandatory row membership evidence under RREF +
  //    Complementary secondary suppression on GROUP BY results.
  //    (Compute the exact set of disclosed rows FIRST so we feed pre-query + every disclosed row +
  //     total into atomic batch RREF differencing without ever committing suppressed rows.)
  const sqlGrouped = hasSqlGroupBy(params.sql);
  const isGroupedQuery = sqlGrouped || params.groupByColumns.length > 0 || params.rows.length > 1;
  const requireMembershipForGroupedRows = params.requireMembershipForGroupedRows !== false;
  const hasCohortHistory = params.differencingGuard.hasCohortHistory(params.sessionKey);
  const hasPredeclaredCohort =
    params.predeclaredCohortMemberIds !== undefined &&
    params.predeclaredCohortMemberIds.length > 0;
  const anyRowHasCohortIds = params.rows.some(
    (r) => r.cohortMemberIds !== undefined && r.cohortMemberIds.length > 0
  );
  const rrefActive =
    params.requireCohortMembership === true ||
    hasCohortHistory ||
    hasPredeclaredCohort ||
    anyRowHasCohortIds;
  const mustEnforceGroupedMembership =
    sqlGrouped ||
    (isGroupedQuery && requireMembershipForGroupedRows) ||
    (rrefActive && params.groupByColumns.length > 0);

  const disclosedWithCohorts: Array<{
    readonly safeRow: AggregateQueryRow;
    readonly cohortMemberIds?: ReadonlyArray<string>;
  }> = [];
  let primarySuppressedCount = 0;
  let missingMembershipSuppressedCount = 0;
  let secondarySuppressedCount = 0;
  let sawPerPerson = false;

  for (const row of params.rows) {
    if (row.unitCount <= 1) {
      sawPerPerson = true;
      primarySuppressedCount += 1;
      continue;
    }
    if (row.unitCount < minK) {
      primarySuppressedCount += 1;
      continue;
    }
    // Always enforce mandatory cohortMemberIds on grouped rows (even on a brand-new session
    // with zero prior history and no pre-declared cohort) unless explicitly opted out.
    if (
      mustEnforceGroupedMembership &&
      (!row.cohortMemberIds || row.cohortMemberIds.length === 0)
    ) {
      missingMembershipSuppressedCount += 1;
      primarySuppressedCount += 1;
      continue;
    }
    // Strip cohortMemberIds and extraColumns before handing rows to model!
    disclosedWithCohorts.push({
      safeRow: {
        bucketLabel: row.bucketLabel,
        unitCount: row.unitCount,
        metricKey: row.metricKey,
        metricValue: row.metricValue,
        unit: row.unit,
      },
      cohortMemberIds: row.cohortMemberIds,
    });
  }

  // Complementary secondary suppression: on GROUP BY queries, if ONLY 1 cell was suppressed by
  // primary (< k or missing membership) suppression, an attacker knowing the ungrouped site total
  // could recover that single suppressed cell by subtracting all remaining sibling cells. Suppress
  // the next-smallest sibling cell (`unitCount`, tie-broken by `|metricValue|` then `bucketLabel`)!
  if (
    isGroupedQuery &&
    primarySuppressedCount === 1 &&
    disclosedWithCohorts.length >= 1
  ) {
    let smallestIdx = 0;
    for (let i = 1; i < disclosedWithCohorts.length; i++) {
      const curr = disclosedWithCohorts[i].safeRow;
      const best = disclosedWithCohorts[smallestIdx].safeRow;
      if (
        curr.unitCount < best.unitCount ||
        (curr.unitCount === best.unitCount &&
          Math.abs(curr.metricValue) < Math.abs(best.metricValue)) ||
        (curr.unitCount === best.unitCount &&
          Math.abs(curr.metricValue) === Math.abs(best.metricValue) &&
          curr.bucketLabel < best.bucketLabel)
      ) {
        smallestIdx = i;
      }
    }
    disclosedWithCohorts.splice(smallestIdx, 1);
    secondarySuppressedCount = 1;
  }

  const safeRows = disclosedWithCohorts.map((d) => d.safeRow);
  const suppressedCount = primarySuppressedCount + secondarySuppressedCount;

  if (safeRows.length === 0 && params.rows.length > 0) {
    const allOriginalPerPerson =
      sawPerPerson && secondarySuppressedCount === 0 && params.rows.every((r) => r.unitCount <= 1);
    const blockedCode = allOriginalPerPerson
      ? 'PER_PERSON_AGGREGATION_BLOCKED'
      : missingMembershipSuppressedCount > 0 &&
          primarySuppressedCount === missingMembershipSuppressedCount
        ? 'DIFFERENCING_ATTACK_BLOCKED'
        : 'SMALL_CELL_SUPPRESSED';
    return {
      allowed: false,
      blockedCode,
      reason:
        blockedCode === 'DIFFERENCING_ATTACK_BLOCKED'
          ? 'disclosure_blocked_differencing'
          : 'disclosure_suppressed_k_anonymity',
      safeRows: [],
      suppressedCount,
      secondarySuppressedCount,
    };
  }

  // 7. Atomic batch RREF differencing check across pre-declared cohort + EVERY individually
  //    disclosed group row + the disclosed total row (binds windowStart..windowEnd).
  //    Evaluates dry-run first; commits ALL (window + cohort batch) ONLY when entire response is approved!
  const boundSignature =
    params.windowStart && params.windowEnd
      ? `${params.filterSignature}|win:${params.windowStart}..${params.windowEnd}`
      : params.filterSignature;

  const batchEntries: Array<{
    readonly filterSignature: string;
    readonly cohortMemberIds: ReadonlyArray<string>;
  }> = [];
  const disclosedUnionSet = new Set<string>();

  if (hasPredeclaredCohort && params.predeclaredCohortMemberIds) {
    batchEntries.push({
      filterSignature: `${boundSignature}|predeclared`,
      cohortMemberIds: params.predeclaredCohortMemberIds,
    });
  }

  for (const item of disclosedWithCohorts) {
    if (item.cohortMemberIds && item.cohortMemberIds.length > 0) {
      batchEntries.push({
        filterSignature: `${boundSignature}|row:${item.safeRow.bucketLabel}`,
        cohortMemberIds: item.cohortMemberIds,
      });
      for (const id of item.cohortMemberIds) {
        disclosedUnionSet.add(id);
      }
    }
  }
  if (disclosedUnionSet.size > 0) {
    batchEntries.push({
      filterSignature: `${boundSignature}|total`,
      cohortMemberIds: Array.from(disclosedUnionSet),
    });
  }

  if (batchEntries.length > 0) {
    const diffCheck = params.differencingGuard.checkAndRecordBatch(
      params.sessionKey,
      batchEntries,
      { commit: false }
    );
    if (!diffCheck.allowed) {
      return {
        allowed: false,
        blockedCode: 'DIFFERENCING_ATTACK_BLOCKED',
        reason: 'disclosure_blocked_differencing',
        safeRows: [],
        suppressedCount: params.rows.length,
      };
    }
  }

  // 8. Entire Ask disclosure approved: build idempotent atomic commit callback for window + cohort
  //    batch equations. When `deferCommit: true`, caller MUST invoke `commitDisclosureHistory()`
  //    ONLY after final answer validation (`verifyAnswerNumericReferences` / `buildResponseEnvelope`).
  let committed = false;
  const commitDisclosureHistory = (): void => {
    if (committed) return;
    committed = true;
    if (pendingWindowCheck) {
      params.differencingGuard.checkAndRecordWindow(pendingWindowCheck, { commit: true });
    }
    if (batchEntries.length > 0) {
      params.differencingGuard.checkAndRecordBatch(params.sessionKey, batchEntries, {
        commit: true,
      });
    }
  };

  if (!params.deferCommit) {
    commitDisclosureHistory();
  }

  return {
    allowed: true,
    safeRows,
    suppressedCount,
    secondarySuppressedCount,
    commitDisclosureHistory,
  };
}

// =========================================================================
// 7. Numeric Citation Grounding Guard
// =========================================================================

/**
 * Verifies that every numeric literal appearing in the final answer text
 * matches a grounded `VerifiedMetricValue` citation from the executed query.
 */
export function verifyAnswerNumericReferences(
  answerText: string,
  citations: ReadonlyArray<GroundedNumericCitation>
): { readonly valid: boolean; readonly ungroundedNumbers: ReadonlyArray<string> } {
  const allowedStrings = new Set<string>();
  for (const c of citations) {
    allowedStrings.add(String(c.value));
    allowedStrings.add(c.value.toFixed(2));
    allowedStrings.add(c.value.toFixed(4));
    allowedStrings.add((c.value * 100).toFixed(2));
    allowedStrings.add(Math.round(c.value).toString());
  }

  // Strip citation tags `[ref:c1]` and ISO-8601 date/timestamp labels (e.g. `2026-11-20`)
  // before checking that every quantitative metric number is grounded in VerifiedMetricValue.
  const stripped = answerText
    .replace(/\[ref:[^\]]+\]/g, '')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?\b/g, '');
  const matches = stripped.match(/(?<![A-Za-z0-9_])\d+(?:\.\d+)?(?![A-Za-z0-9_])/g) ?? [];
  const ungrounded: string[] = [];

  for (const m of matches) {
    if (!allowedStrings.has(m)) {
      ungrounded.push(m);
    }
  }

  return {
    valid: ungrounded.length === 0,
    ungroundedNumbers: ungrounded,
  };
}
