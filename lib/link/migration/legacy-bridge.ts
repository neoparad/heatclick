/**
 * UGOKI LINK v2 — Legacy Data Bridge (§5.10 / store-final.md M11)
 *
 * Enforces the exact §5.10 irreversible sequence and evidence invariants:
 * 1. Fold rows older than the site retention cutoff into k-thresholded statistics
 *    (default k = 50) BEFORE dropping expired rows.
 * 2. Evaluate conversion rules against legacy click strings (`element_selector`,
 *    `element_text`, `href`) BEFORE stripping those strings — reversing this
 *    order raises `LegacyBridgeOrderError` because historical conversions would
 *    be permanently unrecoverable!
 * 3. Reconstruct ONLY mathematically recoverable fields as `evidence: 'inferred'`
 *    (page height bounds, depth-band dwell, scroll reversals, web vitals).
 * 4. Unrecoverable fields (`pv_id`, `section_id`, `element_coordinates`,
 *    `form_field_duration_ms`) are NEVER invented — always `not_collected` (`null`).
 * 5. Direct as-measured legacy metrics are capped at `observed` (NEVER `proven`);
 *    reconstructed/calibrated series are `inferred`; ALL legacy rows are excluded
 *    from fingerprint joins and default ML training sets.
 */

export const DEFAULT_LEGACY_FOLD_K = 50;

export class LegacyBridgeOrderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LegacyBridgeOrderError';
  }
}

export interface LegacyScrollRow {
  readonly legacyEventId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly sessionId: string;
  readonly urlKey: string;
  readonly occurredAtMs: number;
  readonly sequenceId: number;
  readonly scrollY: number;
  readonly scrollPercentage: number; // 1..100
  readonly viewportHeight: number;
  readonly dwellDeltaMs: number;
}

export interface LegacyClickRow {
  readonly legacyEventId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly sessionId: string;
  readonly urlKey: string;
  readonly occurredAtMs: number;
  readonly elementSelector: string | null;
  readonly elementText: string | null;
  readonly href: string | null;
}

export interface LegacyVitalRow {
  readonly tenantId: string;
  readonly siteId: string;
  readonly sessionId: string;
  readonly urlKey: string;
  readonly occurredAtMs: number;
  readonly lcpMs?: number | null;
  readonly inpMs?: number | null;
  readonly clsX1000?: number | null;
  readonly ttfbMs?: number | null;
}

export interface LegacyConversionRule {
  readonly cvKey: string;
  readonly ruleVersion: number;
  readonly selectorIncludes?: string;
  readonly textIncludes?: string;
  readonly hrefIncludes?: string;
}

export interface FoldedExpiredStatCell {
  readonly tenantId: string;
  readonly siteId: string;
  readonly urlKey: string;
  readonly monthUtc: string;
  readonly eventCount: number;
  readonly distinctSessions: number;
  readonly kThreshold: number;
  readonly suppressed: boolean;
  readonly evidenceLevel: 'observed';
  readonly collectionGen: 'legacy';
}

export interface LegacyExtractedConversion {
  readonly tenantId: string;
  readonly siteId: string;
  readonly legacyEventId: string;
  readonly sessionId: string;
  readonly urlKey: string;
  readonly occurredAtMs: number;
  readonly cvKey: string;
  readonly ruleVersion: number;
  readonly evidenceLevel: 'observed';
  readonly collectionGen: 'legacy';
  readonly excludeFromFingerprintJoin: true;
  readonly excludeFromDefaultTraining: true;
}

export interface SanitizedLegacyClick {
  readonly legacyEventId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly sessionId: string;
  readonly urlKey: string;
  readonly occurredAtMs: number;
  /** Stripped after conversion rule evaluation so raw selector/text never enters v2 tables. */
  readonly elementSelector: null;
  readonly elementText: null;
  readonly matchedConversionKeys: readonly string[];
  readonly evidenceLevel: 'observed';
  readonly collectionGen: 'legacy';
}

export interface UnrecoverableFieldPlaceholder {
  readonly status: 'not_collected';
  readonly value: null;
  readonly reason: 'legacy_unrecoverable';
}

export interface BridgedLegacyPvRecord {
  readonly tenantId: string;
  readonly siteId: string;
  readonly bridgeHandleId: string;
  readonly sessionId: string;
  readonly urlKey: string;
  readonly pvStartAtMs: number;
  readonly collectionGen: 'legacy';
  /** Direct as-measured counts capped strictly at `observed` (never `proven`). */
  readonly directMeasured: {
    readonly evidenceLevel: 'observed';
    readonly maxEvidenceCap: 'observed';
    readonly canBeProven: false;
    readonly maxScrollY: number;
    readonly clickCount: number;
    readonly conversionCount: number;
  };
  /** Mathematically recoverable fields strictly tagged `inferred`. */
  readonly recovered: {
    readonly evidenceLevel: 'inferred';
    readonly pageHeightRangePx: readonly [number, number] | null;
    readonly depthBandDwellMs: Readonly<Record<string, number>>;
    readonly scrollReversals: number;
    readonly webVitals: {
      readonly lcpMs: number | null;
      readonly inpMs: number | null;
      readonly clsX1000: number | null;
      readonly ttfbMs: number | null;
    };
  };
  /** Never fabricated — explicitly `not_collected` (§5.10). */
  readonly unrecoverable: {
    readonly pv_id: UnrecoverableFieldPlaceholder;
    readonly section_id: UnrecoverableFieldPlaceholder;
    readonly element_coordinates: UnrecoverableFieldPlaceholder;
    readonly form_field_duration_ms: UnrecoverableFieldPlaceholder;
  };
  readonly excludeFromFingerprintJoin: true;
  readonly excludeFromDefaultTraining: true;
}

export interface LegacyBridgeResult {
  readonly executionOrderVerified: readonly [
    'fold_expired_to_k_stats',
    'drop_expired_raw_rows',
    'evaluate_conversion_rules_on_click_strings',
    'strip_click_strings',
    'reconstruct_bridged_pvs',
  ];
  readonly foldedExpiredCells: readonly FoldedExpiredStatCell[];
  readonly droppedExpiredScrollRows: number;
  readonly droppedExpiredClickRows: number;
  readonly extractedConversions: readonly LegacyExtractedConversion[];
  readonly sanitizedClicks: readonly SanitizedLegacyClick[];
  readonly bridgedPvs: readonly BridgedLegacyPvRecord[];
}

const UNRECOVERABLE: UnrecoverableFieldPlaceholder = Object.freeze({
  status: 'not_collected',
  value: null,
  reason: 'legacy_unrecoverable',
});

function monthUtcFromMs(tsMs: number): string {
  const d = new Date(tsMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function depthBandLabel(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  if (clamped < 25) return '0_25';
  if (clamped < 50) return '25_50';
  if (clamped < 75) return '50_75';
  return '75_100';
}

function ruleMatchesClick(
  rule: LegacyConversionRule,
  click: LegacyClickRow
): boolean {
  let hasCondition = false;
  if (rule.selectorIncludes !== undefined) {
    hasCondition = true;
    if (!click.elementSelector?.includes(rule.selectorIncludes)) return false;
  }
  if (rule.textIncludes !== undefined) {
    hasCondition = true;
    if (!click.elementText?.includes(rule.textIncludes)) return false;
  }
  if (rule.hrefIncludes !== undefined) {
    hasCondition = true;
    if (!click.href?.includes(rule.hrefIncludes)) return false;
  }
  return hasCondition;
}

/**
 * Stateful step-guarded pipeline enforcing §5.10 order invariants so callers
 * CANNOT drop expired rows before folding OR strip click strings before
 * evaluating historical conversion rules.
 */
export class LegacyBridgePipeline {
  private expiredFolded = false;
  private expiredDropped = false;
  private conversionsEvaluated = false;
  private clickStringsStripped = false;

  private activeScrollRows: LegacyScrollRow[];
  private activeClickRows: LegacyClickRow[];
  private readonly vitalRows: readonly LegacyVitalRow[];
  private readonly kThreshold: number;

  private foldedCells: FoldedExpiredStatCell[] = [];
  private droppedScrollCount = 0;
  private droppedClickCount = 0;
  private extractedConversions: LegacyExtractedConversion[] = [];
  private sanitizedClicks: SanitizedLegacyClick[] = [];

  public constructor(args: {
    readonly scrollRows: readonly LegacyScrollRow[];
    readonly clickRows: readonly LegacyClickRow[];
    readonly vitalRows?: readonly LegacyVitalRow[];
    readonly kThreshold?: number;
  }) {
    this.activeScrollRows = [...args.scrollRows];
    this.activeClickRows = [...args.clickRows];
    this.vitalRows = args.vitalRows ?? [];
    this.kThreshold = args.kThreshold ?? DEFAULT_LEGACY_FOLD_K;
  }

  /**
   * Step 1: Fold rows older than `retentionCutoffMs` into k-thresholded statistics.
   */
  public foldExpiredToKStats(retentionCutoffMs: number): readonly FoldedExpiredStatCell[] {
    const buckets = new Map<
      string,
      { tenantId: string; siteId: string; urlKey: string; monthUtc: string; events: number; sessions: Set<string> }
    >();

    const addExpired = (
      tenantId: string,
      siteId: string,
      urlKey: string,
      occurredAtMs: number,
      sessionId: string
    ) => {
      if (occurredAtMs >= retentionCutoffMs) return;
      const monthUtc = monthUtcFromMs(occurredAtMs);
      const key = `${tenantId}\u0000${siteId}\u0000${urlKey}\u0000${monthUtc}`;
      let b = buckets.get(key);
      if (!b) {
        b = { tenantId, siteId, urlKey, monthUtc, events: 0, sessions: new Set() };
        buckets.set(key, b);
      }
      b.events += 1;
      b.sessions.add(sessionId);
    };

    for (const s of this.activeScrollRows) {
      addExpired(s.tenantId, s.siteId, s.urlKey, s.occurredAtMs, s.sessionId);
    }
    for (const c of this.activeClickRows) {
      addExpired(c.tenantId, c.siteId, c.urlKey, c.occurredAtMs, c.sessionId);
    }

    this.foldedCells = Array.from(buckets.values())
      .map((b) => {
        const distinctSessions = b.sessions.size;
        const suppressed = distinctSessions < this.kThreshold;
        return {
          tenantId: b.tenantId,
          siteId: b.siteId,
          urlKey: b.urlKey,
          monthUtc: b.monthUtc,
          eventCount: suppressed ? 0 : b.events,
          distinctSessions: suppressed ? 0 : distinctSessions,
          kThreshold: this.kThreshold,
          suppressed,
          evidenceLevel: 'observed' as const,
          collectionGen: 'legacy' as const,
        };
      })
      .sort((a, b) =>
        `${a.tenantId}:${a.siteId}:${a.monthUtc}:${a.urlKey}`.localeCompare(
          `${b.tenantId}:${b.siteId}:${b.monthUtc}:${b.urlKey}`
        )
      );

    this.expiredFolded = true;
    return this.foldedCells;
  }

  /**
   * Step 2: Drop expired rows ONLY after Step 1 fold is completed.
   */
  public dropExpiredRawRows(retentionCutoffMs: number): {
    readonly droppedScrollRows: number;
    readonly droppedClickRows: number;
  } {
    if (!this.expiredFolded) {
      throw new LegacyBridgeOrderError(
        'Cannot drop expired legacy rows before folding them into k-thresholded statistics (§5.10)'
      );
    }
    const keptScroll = this.activeScrollRows.filter(
      (r) => r.occurredAtMs >= retentionCutoffMs
    );
    const keptClicks = this.activeClickRows.filter(
      (r) => r.occurredAtMs >= retentionCutoffMs
    );
    this.droppedScrollCount = this.activeScrollRows.length - keptScroll.length;
    this.droppedClickCount = this.activeClickRows.length - keptClicks.length;
    this.activeScrollRows = keptScroll;
    this.activeClickRows = keptClicks;
    this.expiredDropped = true;
    return {
      droppedScrollRows: this.droppedScrollCount,
      droppedClickRows: this.droppedClickCount,
    };
  }

  /**
   * Step 3: Evaluate conversion rules against legacy click strings BEFORE dropping them!
   */
  public evaluateConversionRulesBeforeStringDrop(
    rules: readonly LegacyConversionRule[]
  ): readonly LegacyExtractedConversion[] {
    if (this.clickStringsStripped) {
      throw new LegacyBridgeOrderError(
        'Click strings were already stripped; conversion rules MUST run BEFORE dropping click strings (§5.10)'
      );
    }

    const extracted: LegacyExtractedConversion[] = [];
    for (const click of this.activeClickRows) {
      for (const rule of rules) {
        if (ruleMatchesClick(rule, click)) {
          extracted.push({
            tenantId: click.tenantId,
            siteId: click.siteId,
            legacyEventId: click.legacyEventId,
            sessionId: click.sessionId,
            urlKey: click.urlKey,
            occurredAtMs: click.occurredAtMs,
            cvKey: rule.cvKey,
            ruleVersion: rule.ruleVersion,
            evidenceLevel: 'observed',
            collectionGen: 'legacy',
            excludeFromFingerprintJoin: true,
            excludeFromDefaultTraining: true,
          });
        }
      }
    }

    this.extractedConversions = extracted;
    this.conversionsEvaluated = true;
    return extracted;
  }

  /**
   * Step 4: Strip raw selector & text strings from legacy clicks ONLY after Step 3!
   */
  public stripClickStrings(): readonly SanitizedLegacyClick[] {
    if (!this.conversionsEvaluated) {
      throw new LegacyBridgeOrderError(
        'Refused to strip legacy click strings before evaluating conversion rules (§5.10 irreversible data loss prevention)'
      );
    }

    const cvByEventId = new Map<string, string[]>();
    for (const cv of this.extractedConversions) {
      const list = cvByEventId.get(cv.legacyEventId) ?? [];
      list.push(cv.cvKey);
      cvByEventId.set(cv.legacyEventId, list);
    }

    this.sanitizedClicks = this.activeClickRows.map((c) => ({
      legacyEventId: c.legacyEventId,
      tenantId: c.tenantId,
      siteId: c.siteId,
      sessionId: c.sessionId,
      urlKey: c.urlKey,
      occurredAtMs: c.occurredAtMs,
      elementSelector: null,
      elementText: null,
      matchedConversionKeys: cvByEventId.get(c.legacyEventId) ?? [],
      evidenceLevel: 'observed',
      collectionGen: 'legacy',
    }));

    // Drop raw string references immediately
    this.activeClickRows = [];
    this.clickStringsStripped = true;
    return this.sanitizedClicks;
  }

  /**
   * Step 5: Reconstruct bridged legacy PV rows with strict `observed` / `inferred`
   * separation and `not_collected` placeholders for all unrecoverable fields.
   */
  public reconstructBridgedPvs(): LegacyBridgeResult {
    if (!this.expiredDropped || !this.clickStringsStripped) {
      throw new LegacyBridgeOrderError(
        'All prior steps (fold -> drop -> evaluate conversions -> strip click strings) must complete before PV reconstruction'
      );
    }

    // Group active scroll rows by (tenantId, siteId, sessionId, urlKey) and split on sequenceId restarts
    const groups = new Map<string, LegacyScrollRow[]>();
    for (const row of this.activeScrollRows) {
      const gk = `${row.tenantId}\u0000${row.siteId}\u0000${row.sessionId}\u0000${row.urlKey}`;
      const list = groups.get(gk) ?? [];
      list.push(row);
      groups.set(gk, list);
    }

    const bridgedPvs: BridgedLegacyPvRecord[] = [];
    let handleSeq = 0;

    for (const rows of groups.values()) {
      rows.sort((a, b) => a.occurredAtMs - b.occurredAtMs);

      // Partition into pseudo-PV segments whenever sequenceId resets (<= prev sequenceId)
      const segments: LegacyScrollRow[][] = [];
      let current: LegacyScrollRow[] = [];
      let prevSeq = -1;
      for (const r of rows) {
        if (current.length > 0 && r.sequenceId <= prevSeq) {
          segments.push(current);
          current = [r];
        } else {
          current.push(r);
        }
        prevSeq = r.sequenceId;
      }
      if (current.length > 0) segments.push(current);

      for (const seg of segments) {
        handleSeq += 1;
        const first = seg[0]!;
        const last = seg[seg.length - 1]!;

        let maxScrollY = 0;
        let reversals = 0;
        let prevY: number | null = null;
        let prevDir = 0; // +1 down, -1 up
        let minDocH = Number.POSITIVE_INFINITY;
        let maxDocH = 0;
        const depthBandDwellMs: Record<string, number> = {
          '0_25': 0,
          '25_50': 0,
          '50_75': 0,
          '75_100': 0,
        };

        for (const r of seg) {
          if (r.scrollY > maxScrollY) maxScrollY = r.scrollY;
          const band = depthBandLabel(r.scrollPercentage);
          depthBandDwellMs[band] = (depthBandDwellMs[band] ?? 0) + Math.max(0, r.dwellDeltaMs);

          if (prevY !== null && r.scrollY !== prevY) {
            const dir = r.scrollY > prevY ? 1 : -1;
            if (prevDir !== 0 && dir !== prevDir) {
              reversals += 1;
            }
            prevDir = dir;
          }
          prevY = r.scrollY;

          // Infer page height interval from scrollY / (scrollPercentage/100) + viewportHeight
          if (r.scrollPercentage > 0 && r.scrollPercentage <= 100) {
            const pctLow = Math.max(0.01, (r.scrollPercentage - 0.5) / 100);
            const pctHigh = Math.min(1.0, (r.scrollPercentage + 0.5) / 100);
            const hLow = Math.round(r.scrollY / pctHigh + r.viewportHeight);
            const hHigh = Math.round(r.scrollY / pctLow + r.viewportHeight);
            if (hLow < minDocH) minDocH = hLow;
            if (hHigh > maxDocH) maxDocH = hHigh;
          }
        }

        const segStart = first.occurredAtMs;
        const segEnd = last.occurredAtMs + 60_000;

        const matchedClicks = this.sanitizedClicks.filter(
          (c) =>
            c.tenantId === first.tenantId &&
            c.siteId === first.siteId &&
            c.sessionId === first.sessionId &&
            c.urlKey === first.urlKey &&
            c.occurredAtMs >= segStart &&
            c.occurredAtMs <= segEnd
        );
        const matchedCvs = matchedClicks.reduce(
          (acc, c) => acc + c.matchedConversionKeys.length,
          0
        );

        const vital = this.vitalRows.find(
          (v) =>
            v.tenantId === first.tenantId &&
            v.siteId === first.siteId &&
            v.sessionId === first.sessionId &&
            v.urlKey === first.urlKey &&
            v.occurredAtMs >= segStart &&
            v.occurredAtMs <= segEnd
        );

        bridgedPvs.push({
          tenantId: first.tenantId,
          siteId: first.siteId,
          bridgeHandleId: `legacy_pv_${handleSeq}`,
          sessionId: first.sessionId,
          urlKey: first.urlKey,
          pvStartAtMs: segStart,
          collectionGen: 'legacy',
          directMeasured: {
            evidenceLevel: 'observed',
            maxEvidenceCap: 'observed',
            canBeProven: false,
            maxScrollY,
            clickCount: matchedClicks.length,
            conversionCount: matchedCvs,
          },
          recovered: {
            evidenceLevel: 'inferred',
            pageHeightRangePx:
              Number.isFinite(minDocH) && maxDocH >= minDocH
                ? [minDocH, maxDocH]
                : null,
            depthBandDwellMs,
            scrollReversals: reversals,
            webVitals: {
              lcpMs: vital?.lcpMs ?? null,
              inpMs: vital?.inpMs ?? null,
              clsX1000: vital?.clsX1000 ?? null,
              ttfbMs: vital?.ttfbMs ?? null,
            },
          },
          unrecoverable: {
            pv_id: UNRECOVERABLE,
            section_id: UNRECOVERABLE,
            element_coordinates: UNRECOVERABLE,
            form_field_duration_ms: UNRECOVERABLE,
          },
          excludeFromFingerprintJoin: true,
          excludeFromDefaultTraining: true,
        });
      }
    }

    return {
      executionOrderVerified: [
        'fold_expired_to_k_stats',
        'drop_expired_raw_rows',
        'evaluate_conversion_rules_on_click_strings',
        'strip_click_strings',
        'reconstruct_bridged_pvs',
      ],
      foldedExpiredCells: this.foldedCells,
      droppedExpiredScrollRows: this.droppedScrollCount,
      droppedExpiredClickRows: this.droppedClickCount,
      extractedConversions: this.extractedConversions,
      sanitizedClicks: this.sanitizedClicks,
      bridgedPvs,
    };
  }
}

/**
 * Convenience runner executing the strictly ordered §5.10 bridge pipeline end-to-end.
 */
export function runLegacyBridge(args: {
  readonly scrollRows: readonly LegacyScrollRow[];
  readonly clickRows: readonly LegacyClickRow[];
  readonly vitalRows?: readonly LegacyVitalRow[];
  readonly conversionRules: readonly LegacyConversionRule[];
  readonly retentionCutoffMs: number;
  readonly kThreshold?: number;
}): LegacyBridgeResult {
  const pipeline = new LegacyBridgePipeline({
    scrollRows: args.scrollRows,
    clickRows: args.clickRows,
    vitalRows: args.vitalRows,
    kThreshold: args.kThreshold,
  });
  pipeline.foldExpiredToKStats(args.retentionCutoffMs);
  pipeline.dropExpiredRawRows(args.retentionCutoffMs);
  pipeline.evaluateConversionRulesBeforeStringDrop(args.conversionRules);
  pipeline.stripClickStrings();
  return pipeline.reconstructBridgedPvs();
}
