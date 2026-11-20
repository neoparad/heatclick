/**
 * UGOKI LINK v2 — Pre-LLM "Aggregation Loophole" Filter, External/Jev Provider Ban,
 * Differencing Attack Guard & Numeric Grounding Verifier (§11.11.11)
 */

import { inspectSqlAst } from '@/lib/link/isolation';
import {
  PUBLIC_AGGREGATE_VIEWS,
  type AggregateQueryRow,
  type AskPlannerProvider,
  type GroundedNumericCitation,
  type PreLlmFilterVerdict,
  type PublicAggregateViewName,
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
// 2. Column & View Allowlists (Blocks Identifiers, Free Text, Per-Person Aggs)
// =========================================================================

const PUBLIC_VIEW_SET: ReadonlySet<string> = new Set(PUBLIC_AGGREGATE_VIEWS);

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

// =========================================================================
// 3. Differencing Attack Guard (Detects Cohort Pairs Isolating < K People)
// =========================================================================

interface CohortHistoryEntry {
  readonly filterSignature: string;
  readonly memberSet: ReadonlySet<string>;
}

export class DifferencingGuard {
  /** Key: `${tenantId}:${siteId}:${permissionEpoch}` */
  private readonly history = new Map<string, CohortHistoryEntry[]>();
  private readonly minCellK: number;

  constructor(minCellK = ASK_MIN_CELL_K) {
    this.minCellK = minCellK;
  }

  /**
   * Checks whether the new query's cohort differs from ANY prior query in the same
   * `(tenantId, siteId, permissionEpoch)` session by 1..(k-1) individuals
   * (classic differencing attack: Q1 = all N users, Q2 = all except target -> N-1 users).
   */
  public checkAndRecord(
    sessionKey: string,
    filterSignature: string,
    cohortMemberIds: ReadonlyArray<string>
  ): { readonly allowed: boolean; readonly isolatedCount?: number } {
    const currSet = new Set(cohortMemberIds);
    const priorList = this.history.get(sessionKey) ?? [];

    for (const prev of priorList) {
      if (prev.filterSignature === filterSignature) {
        continue; // exact repeat of same filter is not a differencing attack
      }
      let onlyInPrev = 0;
      for (const id of prev.memberSet) {
        if (!currSet.has(id)) onlyInPrev += 1;
      }
      let onlyInCurr = 0;
      for (const id of currSet) {
        if (!prev.memberSet.has(id)) onlyInCurr += 1;
      }

      // If symmetric difference or one-sided subset difference isolates between 1 and k-1 individuals -> BLOCK!
      const symDiff = onlyInPrev + onlyInCurr;
      if (
        (symDiff > 0 && symDiff < this.minCellK) ||
        (onlyInPrev > 0 && onlyInPrev < this.minCellK && onlyInCurr === 0) ||
        (onlyInCurr > 0 && onlyInCurr < this.minCellK && onlyInPrev === 0)
      ) {
        return {
          allowed: false,
          isolatedCount: Math.min(
            symDiff,
            onlyInPrev > 0 ? onlyInPrev : symDiff,
            onlyInCurr > 0 ? onlyInCurr : symDiff
          ),
        };
      }
    }

    priorList.push({ filterSignature, memberSet: currSet });
    this.history.set(sessionKey, priorList);
    return { allowed: true };
  }

  public clearSession(sessionKey: string): void {
    this.history.delete(sessionKey);
  }
}

// =========================================================================
// 4. Independent Pre-LLM Query + Result Filter
// =========================================================================

export function filterQueryAndRowsBeforeLlm(params: {
  readonly viewName: string;
  readonly sql: string;
  readonly requestedColumns: ReadonlyArray<string>;
  readonly groupByColumns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<AggregateQueryRow>;
  readonly sessionKey: string;
  readonly filterSignature: string;
  readonly differencingGuard: DifferencingGuard;
  readonly minCellK?: number;
}): PreLlmFilterVerdict {
  const minK = params.minCellK ?? ASK_MIN_CELL_K;

  // 1. Public aggregate view whitelist check
  if (!PUBLIC_VIEW_SET.has(params.viewName as PublicAggregateViewName)) {
    return {
      allowed: false,
      blockedCode: 'NON_WHITELISTED_VIEW',
      reason: `View "${params.viewName}" is not in the public read-only aggregate whitelist`,
      safeRows: [],
      suppressedCount: 0,
    };
  }

  // 2. Column check: reject identifiers & free-text columns before execution/LLM
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
  }

  // 3. Layer-A ClickHouse SQL AST inspection (tenant bind, time bound, no SELECT *, no DDL/SETTINGS)
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

  // 4. Check row-level extra columns for accidental identifier/free-text leaks
  for (const row of params.rows) {
    if (row.extraColumns) {
      for (const k of Object.keys(row.extraColumns)) {
        const lower = k.toLowerCase();
        if (FORBIDDEN_IDENTIFIER_COLUMNS.has(lower)) {
          return {
            allowed: false,
            blockedCode: 'IDENTIFIER_COLUMN_BLOCKED',
            reason: `Result row contained forbidden identifier field "${k}"`,
            safeRows: [],
            suppressedCount: 0,
          };
        }
        if (FORBIDDEN_FREE_TEXT_COLUMNS.has(lower)) {
          return {
            allowed: false,
            blockedCode: 'FREE_TEXT_COLUMN_BLOCKED',
            reason: `Result row contained forbidden free-text field "${k}"`,
            safeRows: [],
            suppressedCount: 0,
          };
        }
      }
    }
  }

  // 5. Differencing attack check across cohort members when present
  const unionCohort: string[] = [];
  for (const r of params.rows) {
    if (r.cohortMemberIds) {
      for (const id of r.cohortMemberIds) unionCohort.push(id);
    }
  }
  if (unionCohort.length > 0) {
    const diffCheck = params.differencingGuard.checkAndRecord(
      params.sessionKey,
      params.filterSignature,
      unionCohort
    );
    if (!diffCheck.allowed) {
      return {
        allowed: false,
        blockedCode: 'DIFFERENCING_ATTACK_BLOCKED',
        reason: `Differencing attack detected: query pair isolates ${diffCheck.isolatedCount} individual(s) (< k=${minK})`,
        safeRows: [],
        suppressedCount: params.rows.length,
      };
    }
  }

  // 6. Suppress any cell with unitCount < k (and reject single-person aggregations outright!)
  const safeRows: AggregateQueryRow[] = [];
  let suppressedCount = 0;
  let sawPerPerson = false;

  for (const row of params.rows) {
    if (row.unitCount <= 1) {
      sawPerPerson = true;
      suppressedCount += 1;
      continue;
    }
    if (row.unitCount < minK) {
      suppressedCount += 1;
      continue;
    }
    // Strip cohortMemberIds before handing rows to model!
    safeRows.push({
      bucketLabel: row.bucketLabel,
      unitCount: row.unitCount,
      metricKey: row.metricKey,
      metricValue: row.metricValue,
      unit: row.unit,
    });
  }

  if (safeRows.length === 0 && params.rows.length > 0) {
    return {
      allowed: false,
      blockedCode: sawPerPerson ? 'PER_PERSON_AGGREGATION_BLOCKED' : 'SMALL_CELL_SUPPRESSED',
      reason: sawPerPerson
        ? 'Single-person aggregation blocked by pre-LLM filter'
        : `All ${params.rows.length} rows fell below privacy threshold k=${minK}`,
      safeRows: [],
      suppressedCount,
    };
  }

  return {
    allowed: true,
    safeRows,
    suppressedCount,
  };
}

// =========================================================================
// 5. Numeric Citation Grounding Guard
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
