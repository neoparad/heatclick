/**
 * UGOKI LINK v2 — Loader, Idempotent Merger & 1-Hour Sealed Rollup Types
 */

import type {
  ConsentMode,
  ConsentPurpose,
  DomState,
  NavType,
  TelemetryLogItem,
} from '../../packages/contract/schema';
import type { DataRegion } from '../link-wal';

export interface PvPlacement {
  readonly tenantId: string;
  readonly siteId: string;
  readonly pvId: string;
  readonly urlId: string;
  readonly keyVer: number;
  readonly profileRev: number;
  readonly pvStartSrvMs: number;
  readonly pvHourMs: number;
  readonly pvHourIso: string;
  readonly retentionDays: number;
  readonly expWeek: string; // YYYY-MM-DD (UTC Monday)
  readonly placementBiasMs: number;
}

export interface PvIndexRow {
  readonly tenantId: string;
  readonly siteId: string;
  readonly pvId: string;
  readonly urlId: string;
  readonly keyVer: number;
  readonly profileRev: number;
  readonly pvStartSrvMs: number;
  readonly pvHourMinMs: number;
  readonly pvHourMaxMs: number;
  readonly expWeek: string;
  readonly retentionDays: number;
  readonly minEstimateStartMs: number;
  readonly placementBiasMs: number;
  readonly visitorKey: string | null;
  readonly sessionKey: string | null;
  readonly consentMode: ConsentMode;
  readonly skelFp: string;
  readonly variantKey: string;
  readonly firstFrameReceivedAtMs: number;
  readonly excludeFromHumanRollups?: boolean;
}

export interface ArgMaxRegister<T> {
  readonly value: T;
  readonly seq: number;
  readonly frameHash: string;
}

export interface MergedSectionState {
  readonly sec_fp: string;
  readonly vis_ms: number;
  readonly t_first_ms: number;
  readonly entries: number;
  readonly max_frac_permille: number;
}

export interface MergedBlockState {
  readonly blk_fp: string;
  readonly vis_ms: number;
  readonly copy_n: number;
}

export interface MergedFieldState {
  readonly el_fp: string;
  readonly focus_ms: number;
  readonly invalid_n: number;
}

export interface MergedFormState {
  readonly form_fp: string;
  readonly submit_attempts: number;
}

export interface MergedMediaState {
  readonly blk_fp: string;
  readonly played_ms: number;
}

export interface MergedVitalsState {
  readonly lcp_ms: ArgMaxRegister<number> | null;
  readonly inp_ms: ArgMaxRegister<number> | null;
  readonly cls_x1000: ArgMaxRegister<number> | null;
  readonly ttfb_ms: ArgMaxRegister<number> | null;
}

export interface MergedEventRow {
  readonly tenantId: string;
  readonly siteId: string;
  readonly pvHourMs: number;
  readonly urlId: string;
  readonly pvId: string;
  readonly log_i: number;
  readonly item: TelemetryLogItem;
  readonly contentHash: string;
  readonly conflictDetected: boolean;
}

export interface MergedPvState {
  readonly placement: PvPlacement;
  readonly maxSeq: number;
  readonly seenSeqs: ReadonlySet<number>;
  readonly maxAckEchoSeq: number;
  readonly visEpisode: number;
  readonly maxTMono: number;
  readonly minTMono: number;
  readonly tWall: ArgMaxRegister<number>;
  readonly consentMode: ArgMaxRegister<ConsentMode>;
  readonly purposes: ArgMaxRegister<readonly ConsentPurpose[]>;
  readonly pageUrlKey: string;
  readonly navType: NavType;
  readonly startedHidden: boolean;
  readonly scrollMaxPx: number;
  readonly docHFirst: number;
  readonly docHMax: number;
  readonly docHLast: ArgMaxRegister<number>;
  readonly visMs: number;
  readonly reversals: number;
  readonly jsErrorN: number;
  readonly degradeLevel: number;
  readonly liveWord: number;
  readonly keyDegraded: boolean;
  readonly domState: ArgMaxRegister<DomState>;
  readonly skelFp: ArgMaxRegister<string>;
  readonly cssFp: ArgMaxRegister<string | null>;
  readonly headFp: ArgMaxRegister<string | null>;
  readonly variantKey: ArgMaxRegister<string>;
  readonly samplePi: ArgMaxRegister<number>;
  readonly stateIncomplete: boolean;
  readonly sections: ReadonlyMap<string, MergedSectionState>;
  readonly blocks: ReadonlyMap<string, MergedBlockState>;
  readonly fields: ReadonlyMap<string, MergedFieldState>;
  readonly forms: ReadonlyMap<string, MergedFormState>;
  readonly media: ReadonlyMap<string, MergedMediaState>;
  readonly vitals: MergedVitalsState;
  readonly events: ReadonlyMap<number, MergedEventRow>;
  readonly logConflictCount: number;
  readonly visitorId: string | null;
  readonly sessionId: string | null;
  readonly excludeFromHumanRollups?: boolean;
}

export interface DeletionTombstoneSpec {
  readonly tenantId: string;
  readonly siteId: string;
  readonly pvIds?: readonly string[];
  readonly visitorKeys?: readonly string[];
  readonly memberHashes?: readonly string[];
}

export interface PersistedShardTombstones {
  readonly version: 1;
  readonly region: DataRegion;
  readonly shard_id: number;
  readonly deleted_pv_keys: readonly string[];
  readonly deleted_visitor_keys: readonly string[];
  readonly deleted_member_hashes: readonly string[];
  readonly purged_wal_keys: readonly string[];
}

export interface FrameLogRow {
  readonly tenantId: string;
  readonly siteId: string;
  readonly expWeek: string;
  readonly pvHourMs: number;
  readonly urlId: string;
  readonly pvId: string;
  readonly seq: number;
  readonly frameHash: string;
  readonly ackEchoSeq: number;
  readonly liveWord: number;
  readonly receivedAtMs: number;
  readonly walKey: string;
}

export interface DecisionRecord {
  readonly tenantId: string;
  readonly siteId: string;
  readonly expWeek: string;
  readonly layerId: string;
  readonly decidedHourMs: number;
  readonly decisionId: string;
  readonly experimentId: string;
  readonly armId: string;
  readonly unitId: string;
  readonly propensity: number;
  readonly pvId: string | null;
  readonly skelFp: string;
  readonly variantKey: string;
}

export interface AccessObsRecord {
  readonly tenantId: string;
  readonly siteId: string;
  readonly expWeek: string;
  readonly dayEdge: string;
  readonly capturePath: string;
  readonly reqUid: string;
  readonly sub: number;
  readonly urlId: string;
  readonly addressClass: 'E' | 'T' | 'P';
  readonly uaReduced: string;
}

export interface LoadControlTotals {
  readonly frames: number;
  readonly uniquePvs: number;
  readonly events: number;
  readonly sumScrollMaxPx: number;
  readonly sumVisMs: number;
}

export interface LoadManifest {
  readonly manifest_version: 1;
  readonly region: DataRegion;
  readonly shard_id: number;
  readonly manifest_seq: number;
  readonly wal_keys: readonly string[];
  /** Optional list of WAL keys intentionally purged/expired after commit (Codex R2 #10). */
  readonly purged_wal_keys?: readonly string[];
  readonly committed_at_ms: number;
  readonly frame_keys: readonly string[];
  readonly control_totals: LoadControlTotals;
}

export interface DirtyCell {
  readonly tenantId: string;
  readonly siteId: string;
  readonly pvHourMs: number;
  readonly reason: 'initial_load' | 'late_frame' | 'deletion' | 'alias_change';
  readonly markedAtMs: number;
  readonly dirtyCount: number;
}

export interface RollupMetrics {
  readonly pvCount: number;
  readonly sumScrollMaxPx: number;
  readonly sumVisMs: number;
  readonly engagedPvCount: number;
  readonly eventCount: number;
  readonly sumReversals: number;
  readonly lcpCount: number;
  readonly lcpSumMs: number;
}

export interface PageHourRollupRow extends RollupMetrics {
  readonly tenantId: string;
  readonly siteId: string;
  readonly pvHourMs: number;
  readonly urlId: string;
  readonly buildSeq: number;
}

export interface SiteHourRollupRow extends RollupMetrics {
  readonly tenantId: string;
  readonly siteId: string;
  readonly pvHourMs: number;
  readonly buildSeq: number;
  readonly distinctUrlCount: number;
}

export interface RollupManifestEntry {
  readonly tenantId: string;
  readonly siteId: string;
  readonly pvHourMs: number;
  readonly currentBuildSeq: number;
  readonly sealedAtMs: number;
  readonly sourcePvCount: number;
  readonly sourceEventCount: number;
  readonly state: 'valid' | 'invalid';
}

export interface StoreQualityBlock {
  readonly seamHourMs: number;
  readonly builderLagMs: number;
  readonly maxAllowedLagMs: number;
  readonly sealedHoursIncluded: number;
  readonly tailSpanMs: number;
  readonly invalidCellsExcluded: number;
  readonly doublePlacementCount: number;
}

export interface TodayQueryResult {
  readonly status: 'ok' | 'insufficient_data';
  readonly unmet_gates: readonly string[];
  readonly tenantId: string;
  readonly siteId: string;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly totals: RollupMetrics | null;
  readonly byUrlId: ReadonlyMap<string, RollupMetrics> | null;
  readonly quality: StoreQualityBlock;
}
