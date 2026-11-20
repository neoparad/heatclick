/**
 * UGOKI LINK v2 — Registered Segments (Immutable Versioning, Tri-State Rule Evaluation,
 * Future Wave 6-A ML Extension Contract & k<10 Suppressed Comparison)
 *
 * Implements Wave 4-A requirements & §11.5 / §8.6:
 *   - Immutable versioned segment definitions (`version` increments on every update)
 *   - Extension contract `SegmentDefinitionKind = 'rule' | 'centroid_ml' | 'density_ml'`
 *     for seamless Wave 6-A learned segment plug-in (centroid/density + ID inheritance)
 *   - Tri-state rule evaluation (`true | false | 'unknown'`): unknown attributes NEVER auto-promote
 *   - Segment comparison with per-measure `EvidenceLevel`, `VerifiedMetricValue`, and k < 10 suppression
 */

import crypto from 'node:crypto';
import {
  canonicalJson,
  createDataLayerMetric,
  sha256Hex,
  type EvidenceRef,
  type MeasureInput,
  type VerifiedNumericLeaf,
} from '@/packages/contract/response';

// =========================================================================
// 1. Segment Definition Contract (`rule` | `centroid_ml` | `density_ml`)
// =========================================================================

export type SegmentDefinitionKind = 'rule' | 'centroid_ml' | 'density_ml';

export type ComparisonOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains';

export interface SegmentLeafPredicate {
  readonly type: 'predicate';
  readonly field: string;
  readonly op: ComparisonOp;
  readonly value: string | number | boolean | ReadonlyArray<string | number>;
}

export interface SegmentGroupRule {
  readonly type: 'and' | 'or' | 'not';
  readonly children: ReadonlyArray<SegmentRuleNode>;
}

export type SegmentRuleNode = SegmentLeafPredicate | SegmentGroupRule;

/**
 * Extension descriptor for Wave 6-A learned segments (`centroid_ml` / `density_ml`).
 * Supports stable `inheritedSegmentId` across model retrains (§8.6).
 */
export interface MlSegmentDescriptor {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly featureNames: ReadonlyArray<string>;
  readonly centroidVector?: ReadonlyArray<number>;
  readonly maxDistance?: number;
  readonly densityThreshold?: number;
  readonly inheritedSegmentId?: string;
}

export interface RegisteredSegment {
  readonly segmentId: string;
  readonly version: number;
  readonly tenantId: string;
  readonly siteId: string;
  readonly name: string;
  readonly description: string;
  readonly kind: SegmentDefinitionKind;
  readonly rule?: SegmentRuleNode;
  readonly mlDescriptor?: MlSegmentDescriptor;
  readonly contentSha256: string;
  readonly createdAt: string;
  readonly createdByPrincipalId: string;
}

// =========================================================================
// 2. Tri-State Rule Evaluation (Unknown NEVER Auto-Promoted)
// =========================================================================

export type TriStateOutcome = true | false | 'unknown';

export type EvaluationSubject = Readonly<Record<string, string | number | boolean | null | undefined>>;

function isUnknownAttribute(val: unknown): boolean {
  if (val === undefined || val === null) return true;
  if (typeof val === 'string' && val.trim().toLowerCase() === 'unknown') return true;
  if (typeof val === 'number' && !Number.isFinite(val)) return true;
  return false;
}

function evaluateLeaf(node: SegmentLeafPredicate, subject: EvaluationSubject): TriStateOutcome {
  const actual = subject[node.field];
  if (isUnknownAttribute(actual)) {
    // Critical invariant: `unknown` is NEVER auto-promoted to true or false!
    return 'unknown';
  }

  switch (node.op) {
    case 'eq':
      return actual === node.value;
    case 'neq':
      return actual !== node.value;
    case 'gt':
      return typeof actual === 'number' && typeof node.value === 'number'
        ? actual > node.value
        : 'unknown';
    case 'gte':
      return typeof actual === 'number' && typeof node.value === 'number'
        ? actual >= node.value
        : 'unknown';
    case 'lt':
      return typeof actual === 'number' && typeof node.value === 'number'
        ? actual < node.value
        : 'unknown';
    case 'lte':
      return typeof actual === 'number' && typeof node.value === 'number'
        ? actual <= node.value
        : 'unknown';
    case 'in':
      return Array.isArray(node.value)
        ? (node.value as ReadonlyArray<string | number>).includes(actual as string | number)
        : 'unknown';
    case 'contains':
      return typeof actual === 'string' && typeof node.value === 'string'
        ? actual.includes(node.value)
        : 'unknown';
  }
}

/**
 * Evaluates a nested AND / OR / NOT rule tree using Kleene three-valued logic.
 * An `unknown` attribute can NEVER silently turn a failing or unverified clause into `true`.
 */
export function evaluateSegmentRule(
  node: SegmentRuleNode,
  subject: EvaluationSubject
): TriStateOutcome {
  if (node.type === 'predicate') {
    return evaluateLeaf(node, subject);
  }
  if (node.type === 'not') {
    if (node.children.length === 0) return 'unknown';
    const child = evaluateSegmentRule(node.children[0], subject);
    if (child === 'unknown') return 'unknown';
    return !child;
  }
  if (node.type === 'and') {
    if (node.children.length === 0) return 'unknown';
    let sawUnknown = false;
    for (const child of node.children) {
      const r = evaluateSegmentRule(child, subject);
      if (r === false) return false;
      if (r === 'unknown') sawUnknown = true;
    }
    return sawUnknown ? 'unknown' : true;
  }
  // 'or'
  if (node.children.length === 0) return 'unknown';
  let sawUnknown = false;
  for (const child of node.children) {
    const r = evaluateSegmentRule(child, subject);
    if (r === true) return true;
    if (r === 'unknown') sawUnknown = true;
  }
  return sawUnknown ? 'unknown' : false;
}

/**
 * Evaluates any registered segment (`rule`, `centroid_ml`, or `density_ml`).
 * ML segments fail-closed to `'unknown'` if any required feature is missing/unknown.
 */
export function evaluateSegmentMembership(
  segment: RegisteredSegment,
  subject: EvaluationSubject
): TriStateOutcome {
  if (segment.kind === 'rule') {
    if (!segment.rule) return 'unknown';
    return evaluateSegmentRule(segment.rule, subject);
  }

  const ml = segment.mlDescriptor;
  if (!ml || ml.featureNames.length === 0) return 'unknown';

  const vec: number[] = [];
  for (const fname of ml.featureNames) {
    const raw = subject[fname];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return 'unknown';
    }
    vec.push(raw);
  }

  if (segment.kind === 'centroid_ml') {
    if (!ml.centroidVector || ml.centroidVector.length !== vec.length || ml.maxDistance === undefined) {
      return 'unknown';
    }
    let sumSq = 0;
    for (let i = 0; i < vec.length; i++) {
      const diff = vec[i] - ml.centroidVector[i];
      sumSq += diff * diff;
    }
    return Math.sqrt(sumSq) <= ml.maxDistance;
  }

  // `density_ml`: squared radial proximity proxy when kernel density threshold is supplied
  if (ml.centroidVector && ml.centroidVector.length === vec.length && ml.densityThreshold !== undefined) {
    let sumSq = 0;
    for (let i = 0; i < vec.length; i++) {
      const diff = vec[i] - ml.centroidVector[i];
      sumSq += diff * diff;
    }
    const densityScore = Math.exp(-0.5 * sumSq);
    return densityScore >= ml.densityThreshold;
  }

  return 'unknown';
}

// =========================================================================
// 3. Immutable Versioned Segment Registry
// =========================================================================

export class SegmentRegistry {
  /** Key: `${tenantId}:${siteId}:${segmentId}` -> chronological immutable versions */
  private readonly history = new Map<string, RegisteredSegment[]>();

  private key(tenantId: string, siteId: string, segmentId: string): string {
    return `${tenantId}:${siteId}:${segmentId}`;
  }

  public register(params: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly segmentId?: string;
    readonly name: string;
    readonly description?: string;
    readonly kind: SegmentDefinitionKind;
    readonly rule?: SegmentRuleNode;
    readonly mlDescriptor?: MlSegmentDescriptor;
    readonly createdByPrincipalId: string;
    readonly now?: Date;
  }): RegisteredSegment {
    if (params.kind === 'rule' && !params.rule) {
      throw new Error('Rule segment requires a rule AST');
    }
    if ((params.kind === 'centroid_ml' || params.kind === 'density_ml') && !params.mlDescriptor) {
      throw new Error(`${params.kind} segment requires an mlDescriptor`);
    }

    const segmentId = params.segmentId ?? `seg_${crypto.randomBytes(6).toString('hex')}`;
    const k = this.key(params.tenantId, params.siteId, segmentId);
    const existing = this.history.get(k) ?? [];
    const version = existing.length + 1;
    const createdAt = (params.now ?? new Date()).toISOString();

    const canonicalPayload = {
      segmentId,
      version,
      tenantId: params.tenantId,
      siteId: params.siteId,
      name: params.name,
      kind: params.kind,
      rule: params.rule ?? null,
      mlDescriptor: params.mlDescriptor ?? null,
    };
    const contentSha256 = sha256Hex(canonicalJson(canonicalPayload));

    const record: RegisteredSegment = Object.freeze({
      segmentId,
      version,
      tenantId: params.tenantId,
      siteId: params.siteId,
      name: params.name,
      description: params.description ?? '',
      kind: params.kind,
      rule: params.rule,
      mlDescriptor: params.mlDescriptor,
      contentSha256,
      createdAt,
      createdByPrincipalId: params.createdByPrincipalId,
    });

    existing.push(record);
    this.history.set(k, existing);
    return record;
  }

  public getLatest(tenantId: string, siteId: string, segmentId: string): RegisteredSegment | undefined {
    const list = this.history.get(this.key(tenantId, siteId, segmentId));
    return list && list.length > 0 ? list[list.length - 1] : undefined;
  }

  public getVersion(
    tenantId: string,
    siteId: string,
    segmentId: string,
    version: number
  ): RegisteredSegment | undefined {
    const list = this.history.get(this.key(tenantId, siteId, segmentId));
    return list?.find((s) => s.version === version);
  }

  public listForSite(tenantId: string, siteId: string): ReadonlyArray<RegisteredSegment> {
    const prefix = `${tenantId}:${siteId}:`;
    const latestList: RegisteredSegment[] = [];
    for (const [k, versions] of this.history.entries()) {
      if (k.startsWith(prefix) && versions.length > 0) {
        latestList.push(versions[versions.length - 1]);
      }
    }
    return latestList;
  }
}

// =========================================================================
// 4. Segment Comparison with k < 10 Privacy Suppression
// =========================================================================

export const MIN_SEGMENT_CELL_K = 10;

export function toSuppressedBucket(n: number): '0' | '1-4' | '5-9' {
  if (n <= 0) return '0';
  if (n <= 4) return '1-4';
  return '5-9';
}

export interface SegmentObservedMetricsRow {
  readonly segmentId: string;
  readonly segmentVersion: number;
  readonly segmentName: string;
  readonly pageViews: number;
  readonly conversions: number;
  readonly avgDwellMs: number;
  readonly queryRefId: string;
  readonly paramsHash: string;
  readonly resultDigest: string;
  readonly issuedAt: string;
  readonly validUntil: string;
}

export interface SegmentComparisonOutput {
  readonly measures: Readonly<Record<string, MeasureInput<VerifiedNumericLeaf>>>;
  readonly suppressedSegments: ReadonlyArray<{
    readonly segmentId: string;
    readonly nBucket: '0' | '1-4' | '5-9';
    readonly reason: string;
  }>;
}

export function buildSegmentComparisonMeasures(
  rows: ReadonlyArray<SegmentObservedMetricsRow>,
  minCellK = MIN_SEGMENT_CELL_K
): SegmentComparisonOutput {
  const measures: Record<string, MeasureInput<VerifiedNumericLeaf>> = {};
  const suppressedSegments: Array<{ segmentId: string; nBucket: '0' | '1-4' | '5-9'; reason: string }> = [];

  for (const row of rows) {
    const ref: EvidenceRef = {
      ref_id: row.queryRefId,
      kind: 'query',
      params_hash: row.paramsHash,
      watermarks: { sealed_through: row.issuedAt },
      result_digest: row.resultDigest,
      issued_at: row.issuedAt,
      valid_until: row.validUntil,
      kid: 'surface_v1',
    };

    if (row.pageViews < minCellK) {
      suppressedSegments.push({
        segmentId: row.segmentId,
        nBucket: toSuppressedBucket(row.pageViews),
        reason: `suppressed_below_k_${minCellK}`,
      });
      const suppressedGate = [
        {
          id: 'store.G-12',
          required: minCellK,
          observed: toSuppressedBucket(row.pageViews),
          unlock: `Accumulate >= ${minCellK} page views in segment ${row.segmentId}`,
          reason: 'min_cell',
        },
      ];
      measures[`seg_${row.segmentId}_pvs`] = {
        value: null,
        unit: 'page_views',
        status: 'suppressed',
        reason: `Cell count below privacy threshold k=${minCellK}`,
        evidence: {
          level: 'observed',
          exactness: 'exact',
          criteria: [],
          refs: [ref],
          scope: `segment:${row.segmentId}:v${row.segmentVersion}`,
        },
        sample: null,
        interval: null,
        unmet_gates: suppressedGate,
      };
      measures[`seg_${row.segmentId}_cvr`] = {
        value: null,
        unit: 'ratio',
        status: 'suppressed',
        reason: `Cell count below privacy threshold k=${minCellK}`,
        evidence: {
          level: 'observed',
          exactness: 'exact',
          criteria: [],
          refs: [ref],
          scope: `segment:${row.segmentId}:v${row.segmentVersion}`,
        },
        sample: null,
        interval: null,
        unmet_gates: suppressedGate,
      };
      continue;
    }

    const cvr = row.pageViews > 0 ? row.conversions / row.pageViews : 0;
    measures[`seg_${row.segmentId}_pvs`] = {
      value: createDataLayerMetric(row.pageViews, row.queryRefId, {
        authority: 'sealed_rollup',
        createdAt: row.issuedAt,
      }),
      unit: 'page_views',
      status: 'ok',
      evidence: {
        level: 'observed',
        exactness: 'exact',
        criteria: [],
        refs: [ref],
        scope: `segment:${row.segmentId}:v${row.segmentVersion}`,
      },
      sample: { n: row.pageViews, unit_kind: 'page_view' },
      interval: null,
      unmet_gates: [],
    };
    measures[`seg_${row.segmentId}_cvr`] = {
      value: createDataLayerMetric(Number(cvr.toFixed(6)), row.queryRefId, {
        authority: 'sealed_rollup',
        createdAt: row.issuedAt,
      }),
      unit: 'ratio',
      status: 'ok',
      evidence: {
        level: 'observed',
        exactness: 'exact',
        criteria: [],
        refs: [ref],
        scope: `segment:${row.segmentId}:v${row.segmentVersion}`,
      },
      sample: { n: row.pageViews, unit_kind: 'page_view' },
      interval: null,
      unmet_gates: [],
    };
  }

  return { measures, suppressedSegments };
}
