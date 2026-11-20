/**
 * UGOKI LINK v2 — CRAWL Baseline Matching & Delta-vs-Full Snapshot Switch (§11.11 item 8)
 *
 * Sending mutations-only (delta) on top of a CRAWL render baseline is permitted ONLY when ALL 5 match:
 *   1. `skelFp` (section skeleton fingerprint)
 *   2. `maskedInitialStateHash` (content hash of normalized masked initial DOM)
 *   3. `assetVersion` (CSS/JS asset build revision)
 *   4. `activeVariantSetHash` (exact set of delivered variants/interventions)
 *   5. `maskConfigVersion` (approved mask configuration version)
 *
 * If ANY single field differs, the client MUST transmit a full masked snapshot instead of delta.
 * Any public page text overlaid from CRAWL is strictly marked `overlayKind: 'reference_not_recorded'`.
 */

import { wrapUntrusted, type UntrustedValue } from '@/packages/contract/response';

export interface ReplayBaselineTuple {
  readonly skelFp: string;
  readonly maskedInitialStateHash: string;
  readonly assetVersion: string;
  readonly activeVariantSetHash: string;
  readonly maskConfigVersion: string;
}

export interface ReplayBaselineDecision {
  readonly encoding: 'delta' | 'full_masked_snapshot';
  readonly matched: boolean;
  readonly mismatchedFields: ReadonlyArray<keyof ReplayBaselineTuple>;
  readonly baselineSnapshotId: string | null;
}

export function decideReplayEncoding(
  current: ReplayBaselineTuple,
  crawlBaseline: (ReplayBaselineTuple & { readonly snapshotId: string }) | null
): ReplayBaselineDecision {
  if (!crawlBaseline) {
    return {
      encoding: 'full_masked_snapshot',
      matched: false,
      mismatchedFields: [
        'skelFp',
        'maskedInitialStateHash',
        'assetVersion',
        'activeVariantSetHash',
        'maskConfigVersion',
      ],
      baselineSnapshotId: null,
    };
  }

  const keys: ReadonlyArray<keyof ReplayBaselineTuple> = [
    'skelFp',
    'maskedInitialStateHash',
    'assetVersion',
    'activeVariantSetHash',
    'maskConfigVersion',
  ];
  const mismatched: Array<keyof ReplayBaselineTuple> = [];
  for (const k of keys) {
    if (current[k] !== crawlBaseline[k]) {
      mismatched.push(k);
    }
  }

  if (mismatched.length > 0) {
    return {
      encoding: 'full_masked_snapshot',
      matched: false,
      mismatchedFields: mismatched,
      baselineSnapshotId: null,
    };
  }

  return {
    encoding: 'delta',
    matched: true,
    mismatchedFields: [],
    baselineSnapshotId: crawlBaseline.snapshotId,
  };
}

export interface CrawlReferenceTextOverlay {
  readonly overlayKind: 'reference_not_recorded';
  readonly recordedInSession: false;
  readonly crawlSnapshotId: string;
  readonly sectionFp: string;
  readonly publicText: UntrustedValue;
  readonly disclaimerJa: string;
}

/**
 * Wraps public CRAWL text overlaid onto a masked replay frame with an explicit
 * `reference_not_recorded` badge so viewers never confuse static lab text with recorded user data.
 */
export function createCrawlReferenceTextOverlay(params: {
  readonly crawlSnapshotId: string;
  readonly sectionFp: string;
  readonly publicText: string;
}): CrawlReferenceTextOverlay {
  return {
    overlayKind: 'reference_not_recorded',
    recordedInSession: false,
    crawlSnapshotId: params.crawlSnapshotId,
    sectionFp: params.sectionFp,
    publicText: wrapUntrusted(params.publicText, 'page_content'),
    disclaimerJa:
      '参考表示（検査環境で取得した公開ページの文面であり、訪問者画面の記録そのものではありません）',
  };
}
