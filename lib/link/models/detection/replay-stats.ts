/**
 * UGOKI LINK v2 — Bundle 6-A.3: Aggregate Replay (Tier 0) & k>=50 Long-Term Sequence Stats
 * (`lib/link/models/detection/replay-stats.ts`)
 *
 * Implements §4.6, §5.7, TEL M6:
 * - Aggregate replay over section-token sequences & integer kinematic summaries:
 *   - Transition probability matrix `P(next_sec | current_sec)`
 *   - Backward re-read pattern counts (`from_sec -> to_sec`)
 *   - Hesitation / dwell-spike hotspot sections
 * - Quorum enforcement: published ONLY when `pv_count >= 50` AND `distinct_network_prefixes >= 3` (§4.6).
 * - Long-term generalized sequence layer (§5.7): ZERO identifiers, requires legal sign-off flag,
 *   and suppresses any generalized pattern row occurring fewer than `k = 50` times!
 */

export const MIN_REPLAY_QUORUM_PVS = 50 as const;
export const MIN_REPLAY_QUORUM_PREFIXES = 3 as const;
export const MIN_LONG_TERM_K_ANONYMITY = 50 as const;

export interface SectionSequenceVisitInput {
  readonly network_prefix_hash: string;
  readonly device_class: 'mobile' | 'tablet' | 'desktop';
  readonly page_id: string;
  readonly variant_key: string;
  readonly skel_fp: string;
  /** Ordered sequence of section tokens visited in this PV. */
  readonly section_tokens: readonly string[];
  /** Optional hesitation dwell ms per section in this PV. */
  readonly section_hesitation_ms?: Readonly<Record<string, number>>;
}

export interface AggregateReplayResult {
  readonly status: 'ok' | 'insufficient_data';
  readonly evidence_level: 'observed';
  readonly tier: 0;
  readonly window_notice: string;
  readonly pv_count: number;
  readonly distinct_prefixes: number;
  readonly transition_matrix: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly reread_patterns: readonly { readonly from_sec: string; readonly to_sec: string; readonly count: number }[];
  readonly hesitation_hotspots: readonly { readonly sec_fp: string; readonly mean_hesitation_ms: number }[];
  readonly archetype_paths: readonly { readonly path: readonly string[]; readonly support_count: number }[];
}

/**
 * Computes Tier-0 Aggregate Replay statistics (transition matrix, back-scroll re-read patterns,
 * hesitation hotspots, archetype paths) enforcing the `>=50 PVs && >=3 network prefixes` quorum (§4.6).
 */
export function buildAggregateReplaySummary(
  visits: readonly SectionSequenceVisitInput[],
  options?: {
    readonly decision08bApproved?: boolean;
    readonly sectionOrder?: readonly string[];
  }
): AggregateReplayResult {
  const prefixes = new Set(visits.map((v) => v.network_prefix_hash));
  const windowNotice = options?.decision08bApproved
    ? 'Retention follows site retention class (Decision 8(b) approved).'
    : 'Limited to trailing 30-day window until Owner Decision 8(b) is recorded (§4.6).';

  if (visits.length < MIN_REPLAY_QUORUM_PVS || prefixes.size < MIN_REPLAY_QUORUM_PREFIXES) {
    return {
      status: 'insufficient_data',
      evidence_level: 'observed',
      tier: 0,
      window_notice: windowNotice,
      pv_count: visits.length,
      distinct_prefixes: prefixes.size,
      transition_matrix: {},
      reread_patterns: [],
      hesitation_hotspots: [],
      archetype_paths: [],
    };
  }

  // Order index map to identify backward re-reads
  const orderIndex = new Map<string, number>();
  if (options?.sectionOrder) {
    options.sectionOrder.forEach((sec, idx) => orderIndex.set(sec, idx));
  }

  const transCounts = new Map<string, Map<string, number>>();
  const rereadCounts = new Map<string, number>();
  const hesSum = new Map<string, { sum: number; n: number }>();
  const pathCounts = new Map<string, { path: readonly string[]; count: number }>();

  for (const v of visits) {
    const toks = v.section_tokens;
    for (let i = 0; i < toks.length; i++) {
      if (!orderIndex.has(toks[i])) {
        orderIndex.set(toks[i], orderIndex.size);
      }
      if (i + 1 < toks.length) {
        const from = toks[i];
        const to = toks[i + 1];
        let row = transCounts.get(from);
        if (!row) {
          row = new Map<string, number>();
          transCounts.set(from, row);
        }
        row.set(to, (row.get(to) ?? 0) + 1);

        if ((orderIndex.get(to) ?? 0) < (orderIndex.get(from) ?? 0)) {
          const rk = `${from}->${to}`;
          rereadCounts.set(rk, (rereadCounts.get(rk) ?? 0) + 1);
        }
      }
    }

    if (v.section_hesitation_ms) {
      for (const [sec, ms] of Object.entries(v.section_hesitation_ms)) {
        const cur = hesSum.get(sec) ?? { sum: 0, n: 0 };
        cur.sum += Math.max(0, ms);
        cur.n += 1;
        hesSum.set(sec, cur);
      }
    }

    const compressedPath = toks.slice(0, 8);
    const pKey = compressedPath.join('>');
    const pCur = pathCounts.get(pKey) ?? { path: compressedPath, count: 0 };
    pCur.count += 1;
    pathCounts.set(pKey, pCur);
  }

  const transitionMatrix: Record<string, Record<string, number>> = {};
  for (const [from, targets] of transCounts.entries()) {
    let total = 0;
    for (const c of targets.values()) total += c;
    const row: Record<string, number> = {};
    for (const [to, c] of targets.entries()) {
      row[to] = Number((c / Math.max(1, total)).toFixed(4));
    }
    transitionMatrix[from] = row;
  }

  const rereadPatterns = Array.from(rereadCounts.entries())
    .map(([k, count]) => {
      const [from_sec, to_sec] = k.split('->');
      return { from_sec, to_sec, count };
    })
    .sort((a, b) => b.count - a.count);

  const hesitationHotspots = Array.from(hesSum.entries())
    .map(([sec_fp, stats]) => ({
      sec_fp,
      mean_hesitation_ms: Math.round(stats.sum / Math.max(1, stats.n)),
    }))
    .sort((a, b) => b.mean_hesitation_ms - a.mean_hesitation_ms);

  const archetypePaths = Array.from(pathCounts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((p) => ({ path: p.path, support_count: p.count }));

  return {
    status: 'ok',
    evidence_level: 'observed',
    tier: 0,
    window_notice: windowNotice,
    pv_count: visits.length,
    distinct_prefixes: prefixes.size,
    transition_matrix: transitionMatrix,
    reread_patterns: rereadPatterns,
    hesitation_hotspots: hesitationHotspots,
    archetype_paths: archetypePaths,
  };
}

export interface GeneralizedLongTermSequenceRow {
  readonly week_bucket: string;
  readonly device_class: 'mobile' | 'tablet' | 'desktop';
  readonly role_sequence_token: string; // e.g. 'hero>price>compare>cta' (zero identifiers!)
  readonly occurrence_count: number;
}

export interface LongTermGeneralizedStoreResult {
  readonly status: 'ok' | 'not_entitled';
  readonly kept_rows: readonly GeneralizedLongTermSequenceRow[];
  readonly suppressed_below_k_count: number;
  readonly contains_any_identifier: false;
}

/**
 * Builds identifier-free long-term generalized sequence rows enforcing `k >= 50` identical rows
 * and formal legal sign-off (§5.7 "長期の層").
 */
export function buildLongTermGeneralizedSequences(params: {
  readonly rawRows: ReadonlyArray<{
    readonly week_bucket: string;
    readonly device_class: 'mobile' | 'tablet' | 'desktop';
    readonly role_tokens: readonly string[];
    // Compile-time poison guard: identifiers must never enter the long-term generalized layer!
    readonly pv_id?: never;
    readonly visitor_id?: never;
    readonly session_id?: never;
  }>;
  readonly legalSignOffRecorded: boolean;
  readonly minK?: number;
}): LongTermGeneralizedStoreResult {
  if (!params.legalSignOffRecorded) {
    return {
      status: 'not_entitled',
      kept_rows: [],
      suppressed_below_k_count: params.rawRows.length,
      contains_any_identifier: false,
    };
  }

  const minK = Math.max(MIN_LONG_TERM_K_ANONYMITY, params.minK ?? MIN_LONG_TERM_K_ANONYMITY);
  const grouped = new Map<string, GeneralizedLongTermSequenceRow>();

  for (const r of params.rawRows) {
    const rawRec = r as unknown as Record<string, unknown>;
    if (rawRec.pv_id || rawRec.visitor_id || rawRec.session_id) {
      throw new Error('§5.7 Long-term generalized layer forbids all person/PV identifiers');
    }
    const roleSeq = r.role_tokens.slice(0, 20).join('>');
    const key = `${r.week_bucket}|${r.device_class}|${roleSeq}`;
    const cur = grouped.get(key);
    if (cur) {
      grouped.set(key, { ...cur, occurrence_count: cur.occurrence_count + 1 });
    } else {
      grouped.set(key, {
        week_bucket: r.week_bucket,
        device_class: r.device_class,
        role_sequence_token: roleSeq,
        occurrence_count: 1,
      });
    }
  }

  const kept: GeneralizedLongTermSequenceRow[] = [];
  let suppressed = 0;
  for (const row of grouped.values()) {
    if (row.occurrence_count >= minK) {
      kept.push(row);
    } else {
      suppressed += row.occurrence_count;
    }
  }

  return {
    status: 'ok',
    kept_rows: kept.sort((a, b) => b.occurrence_count - a.occurrence_count),
    suppressed_below_k_count: suppressed,
    contains_any_identifier: false,
  };
}
