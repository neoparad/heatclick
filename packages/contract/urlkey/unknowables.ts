/**
 * UGOKI LINK v2 — Unregistered Search Path & Unclassified Parameter Metadata (`unknowables.ts`)
 *
 * Records sanitized structural observations for:
 * 1. Unregistered search-like URL paths (e.g. `/Search/foo`, `/find/bar`, `/results/baz`)
 *    when no `inputPathPatterns` rule masked the path — NEVER storing raw user search terms!
 * 2. Unclassified query parameter names (`coarse_key: true`) for site profile curation.
 */

const LENGTH_BUCKET_TOKEN_RE = /^__ugk_len_(?:0|1_4|5_16|17_64|65_256|257p)__$/;
const PII_TOKEN = '__ugk_pii__';

const SEARCH_PATH_INDICATOR_SEGMENTS: ReadonlySet<string> = new Set([
  'search',
  'searches',
  'find',
  'query',
  'results',
  'search-results',
  'lookup',
  'seek',
  's',
  'q',
]);

export interface UnknowableSearchPathDetection {
  readonly suspected: boolean;
  readonly matched_prefix: string | null;
  readonly suggested_pattern: string | null;
  readonly segment_count: number;
}

export interface UrlKeyUnknowables {
  readonly unregistered_search_path: UnknowableSearchPathDetection;
  readonly has_unclassified_params: boolean;
  readonly unclassified_param_count: number;
}

/**
 * Inspects a normalized pathname (when `pathMasked === false`) and detects whether it
 * resembles an unregistered site-search path, returning ONLY sanitized pattern metadata
 * with zero raw user search terms.
 */
export function detectUnregisteredSearchPath(
  pathname: string,
  pathMasked: boolean
): UnknowableSearchPathDetection {
  if (pathMasked || !pathname || pathname === '/') {
    return Object.freeze({
      suspected: false,
      matched_prefix: null,
      suggested_pattern: null,
      segment_count: 0,
    });
  }

  const trimmed = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const segs = trimmed.split('/').filter((s) => s.length > 0);
  if (segs.length < 2) {
    return Object.freeze({
      suspected: false,
      matched_prefix: null,
      suggested_pattern: null,
      segment_count: segs.length,
    });
  }

  for (let i = 0; i < segs.length - 1; i++) {
    const lower = segs[i].toLowerCase();
    const nextSeg = segs[i + 1];
    if (
      SEARCH_PATH_INDICATOR_SEGMENTS.has(lower) &&
      !LENGTH_BUCKET_TOKEN_RE.test(nextSeg) &&
      nextSeg !== PII_TOKEN
    ) {
      const prefixSegs = segs.slice(0, i + 1).map((_s, idx) => (idx === i ? lower : ':seg'));
      const hasTail = i + 2 < segs.length;
      const suggestedPattern = `/${prefixSegs.join('/')}/<term>${hasTail ? '/*' : ''}`;
      const matchedPrefix = `/${segs
        .slice(0, i + 1)
        .map((s) => s.toLowerCase())
        .join('/')}`;

      return Object.freeze({
        suspected: true,
        matched_prefix: matchedPrefix,
        suggested_pattern: suggestedPattern,
        segment_count: segs.length,
      });
    }
  }

  return Object.freeze({
    suspected: false,
    matched_prefix: null,
    suggested_pattern: null,
    segment_count: segs.length,
  });
}

export function buildUrlKeyUnknowables(
  pathname: string,
  pathMasked: boolean,
  unclassifiedParamNames: readonly string[]
): UrlKeyUnknowables {
  return Object.freeze({
    unregistered_search_path: detectUnregisteredSearchPath(pathname, pathMasked),
    has_unclassified_params: unclassifiedParamNames.length > 0,
    unclassified_param_count: unclassifiedParamNames.length,
  });
}

export interface UnknowablesSummarySnapshot {
  readonly suspectedSearchPatterns: Readonly<Record<string, number>>;
  readonly unclassifiedParamCounts: Readonly<Record<string, number>>;
}

/**
 * Bounded in-memory aggregator for site-profile unknowables discovery (zero raw values retained).
 */
export class UrlUnknowablesRegistry {
  private readonly maxKeys: number;
  private readonly searchPatterns = new Map<string, number>();
  private readonly unclassifiedParams = new Map<string, number>();

  constructor(maxKeys = 1000) {
    this.maxKeys = Math.max(16, maxKeys);
  }

  public record(input: {
    readonly unknowables: UrlKeyUnknowables;
    readonly unclassified_param_names: readonly string[];
  }): void {
    const sp = input.unknowables.unregistered_search_path;
    if (sp.suspected && sp.suggested_pattern) {
      const prev = this.searchPatterns.get(sp.suggested_pattern);
      if (prev !== undefined) {
        this.searchPatterns.set(sp.suggested_pattern, prev + 1);
      } else if (this.searchPatterns.size < this.maxKeys) {
        this.searchPatterns.set(sp.suggested_pattern, 1);
      }
    }

    for (const paramName of input.unclassified_param_names) {
      const prev = this.unclassifiedParams.get(paramName);
      if (prev !== undefined) {
        this.unclassifiedParams.set(paramName, prev + 1);
      } else if (this.unclassifiedParams.size < this.maxKeys) {
        this.unclassifiedParams.set(paramName, 1);
      }
    }
  }

  public snapshot(): UnknowablesSummarySnapshot {
    const suspectedSearchPatterns: Record<string, number> = {};
    for (const [k, v] of this.searchPatterns) {
      suspectedSearchPatterns[k] = v;
    }
    const unclassifiedParamCounts: Record<string, number> = {};
    for (const [k, v] of this.unclassifiedParams) {
      unclassifiedParamCounts[k] = v;
    }
    return Object.freeze({
      suspectedSearchPatterns: Object.freeze(suspectedSearchPatterns),
      unclassifiedParamCounts: Object.freeze(unclassifiedParamCounts),
    });
  }
}
