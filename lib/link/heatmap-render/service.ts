/**
 * UGOKI LINK v2 — 束 4-I (§11.12): ヒートマップ描画サービス・取得毎認証・単一伏せ/差分攻撃防御・削除失効・費用予約・MCP 道具
 *
 * 設計書 §11.12:
 * 1. **取得毎認証 (`authorizeArtifactFetch`)**:
 *    画像・元数字・ジョブ照会すべてで毎回主体のテナント・サイト・権限・失効エポックを検証。
 *    署名付き URL 単独での公開取得を物理禁止。他テナントは 404 + 監査ログ行 (§11.9)。
 * 2. **単一伏せ判定 & 差分推論攻撃防御 (`HeatmapDisclosureGuard`)**:
 *    画像・元数字・凡例・合計を 1 つの公開判定へ通す。他当事者には暦区切り・<10 伏せ・
 *    二次補完伏せを適用し、重なるセグメントを連続要求して 1 人を割り出す差分攻撃
 *    (`|S1 △ S2| < 10`) をブロックする。
 * 3. **プロンプト注入防御**:
 *    画像 OCR・ページ文字列・区画見出し・要素ラベルはすべて `wrapUntrusted()` で包装。
 *    画像内埋め込み指示が権限・送り先・費用枠を変更できないことをモデル外で不変強制する。
 * 4. **削除・再集計 (`build_seq`) 失効**:
 *    削除イベントまたは集計再構築時に派生画像・キャッシュを即時失効（待機ジョブ公開前にも世代再確認）。
 *    削除後の取得は 410 / 404 で拒否。
 * 5. **費用予約上限 & 保存地域目録**:
 *    ジョブ投入前に費用予約。主体/テナントごとの同時実行数・総画素・枚数・リトライ上限を強制し、
 *    同一 `reproducibility_hash` 成果物を再利用。保存地域メタデータ (`ResidencyBlock`) を付与。
 * 6. **MCP 道具定義 (`HEATMAP_IMAGE_MCP_TOOL`, `invokeHeatmapImageMcpTool`)**:
 *    画像本体 (base64 PNG) + 構造化共通返答データを返却。
 */

import { createHash } from 'node:crypto'

import { AuditLogStore, type Scope } from '@/lib/link/auth'
import {
  buildResponseEnvelope,
  createDataLayerMetric,
  wrapUntrusted,
  type EvidenceLevel,
  type MeasureInput,
  type MeasureStatus,
  type ResidencyBlock,
  type SerializedResponseEnvelope,
  type UnmetGate,
  type UntrustedValue,
  type VerifiedNumericLeaf,
} from '@/packages/contract/response'
import { computeUrlKeyV2 } from '@/packages/contract/urlkey'

import {
  validateActorBucketForHeatmap,
  type ModelInferredDisclosureHeader,
} from './actor-experiment'
import { evaluateHeatmapConsentEligibility } from './consent-matrix'
import {
  assertValidPngDimensions,
  decideHeatmapRenderKind,
  renderDeterministicHeatmapImage,
} from './renderer'
import {
  assertValidHeatmapDisplayLabel,
  computeReproducibilityHash,
  HEATMAP_KIND_DISPLAY_NAMES,
  serializeHeatmapUnitKey,
  type HeatmapActorBucket,
  type HeatmapClickPointInput,
  type HeatmapConsentMode,
  type HeatmapConsentPurpose,
  type HeatmapDataLane,
  type HeatmapDeviceClass,
  type HeatmapJurisdiction,
  type HeatmapKind,
  type HeatmapRenderKind,
  type HeatmapSdkCapability,
  type HeatmapSectionMetricInput,
  type HeatmapUnitDataset,
  type LabScreenshotInput,
  type RedactionBox,
} from './types'

// ---------------------------------------------------------------------------
// 1. Per-Fetch Principal & Authorization Guard (§11.12 — Never Signed-URL Only)
// ---------------------------------------------------------------------------

export interface HeatmapFetchPrincipal {
  readonly principal_id: string
  readonly tenant_id: string
  readonly allowed_site_ids: readonly string[] | '*'
  readonly scopes: readonly Scope[]
  readonly token_revocation_epoch: number
  readonly disabled?: boolean
  readonly audience: 'site_owner' | 'external_party'
}

export interface AuthCheckResult {
  readonly allowed: boolean
  readonly http_status: 200 | 401 | 403 | 404
  readonly reason: string
}

// ---------------------------------------------------------------------------
// 2. Unified Disclosure & Sequential Differencing Attack Guard (§11.12 / §12.3)
// ---------------------------------------------------------------------------

export const EXTERNAL_PARTY_MIN_CELL_K = 10
export const DEFAULT_MAX_OVERLAPPING_EXTERNAL_QUERIES = 8

/** Fixed, numeric-free external rejection reason codes (never interpolate raw counts or deltas!) */
export const DISCLOSURE_BLOCKED_DIFFERENCING = 'disclosure_blocked_differencing'
export const DISCLOSURE_SUPPRESSED_K_ANONYMITY = 'disclosure_suppressed_k_anonymity'
export const DISCLOSURE_REJECTED_NON_CALENDAR_PERIOD = 'disclosure_rejected_non_calendar_period'

function sanitizeExternalRejectionReason(rawReason: string): string {
  const low = rawReason.toLowerCase()
  if (low.includes('differencing') || low === DISCLOSURE_BLOCKED_DIFFERENCING) {
    return DISCLOSURE_BLOCKED_DIFFERENCING
  }
  if (low.includes('calendar') || low === DISCLOSURE_REJECTED_NON_CALENDAR_PERIOD) {
    return DISCLOSURE_REJECTED_NON_CALENDAR_PERIOD
  }
  if (low.includes('k10') || low.includes('k_anonymity') || low.includes('suppress')) {
    return DISCLOSURE_SUPPRESSED_K_ANONYMITY
  }
  // Strip any accidental numeric tokens or parameterized suffixes for external-facing responses
  const stripped = rawReason.replace(/[:=<>].*$/, '').replace(/\d+/g, '').replace(/_+$/, '')
  return stripped || DISCLOSURE_SUPPRESSED_K_ANONYMITY
}

function boxesOverlap(
  a: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  b: Pick<RedactionBox, 'x' | 'y' | 'width' | 'height'>,
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/**
 * Extracts ONLY OCR snippets with explicit post-mask provenance (`from_masked_image: true`
 * and `overlaps_masked_region !== true`) whose bounding box does not intersect any redaction box.
 * Bare strings, pre-mask OCR, or masked-region snippets are omitted completely (never emitted).
 */
function extractSafePostMaskOcrTexts(screenshot: LabScreenshotInput | null): UntrustedValue[] {
  if (!screenshot || !screenshot.embedded_text_samples || screenshot.embedded_text_samples.length === 0) {
    return []
  }
  const redactionBoxes = screenshot.redaction_boxes ?? []
  const safe: UntrustedValue[] = []
  for (const sample of screenshot.embedded_text_samples) {
    if (typeof sample === 'string') {
      // Bare string lacks verified post-mask provenance -> omit completely
      continue
    }
    if (sample.from_masked_image !== true || sample.overlaps_masked_region === true) {
      continue
    }
    if (sample.bbox && redactionBoxes.some((box) => boxesOverlap(sample.bbox!, box))) {
      continue
    }
    safe.push(wrapUntrusted(sample.text, 'heatmap_text'))
  }
  return safe
}

const ISO_EXPLICIT_TZ_RE = /(?:Z|[+-]\d{2}:\d{2})$/
const UTC_DAY_MS = 86_400_000

export interface DisclosureCheckInput {
  readonly principal_id: string
  readonly tenant_id: string
  readonly site_id: string
  readonly page_url_key: string
  readonly audience: 'site_owner' | 'external_party'
  readonly period_start: string
  readonly period_end: string
  readonly segment_id: string
  readonly total_units: number
  readonly subject_ids?: readonly string[]
  readonly sections: readonly HeatmapSectionMetricInput[]
  readonly clicks: readonly HeatmapClickPointInput[]
}

export interface DisclosureCheckResult {
  readonly allowed: boolean
  readonly blocked_differencing_attack: boolean
  readonly non_calendar_period_rejected: boolean
  readonly suppressed_cell_count: number
  readonly sections: readonly HeatmapSectionMetricInput[]
  readonly clicks: readonly HeatmapClickPointInput[]
  readonly reason: string
}

export function isCalendarAlignedIsoRange(startIso: string, endIso: string): boolean {
  if (!ISO_EXPLICIT_TZ_RE.test(startIso) || !ISO_EXPLICIT_TZ_RE.test(endIso)) {
    return false
  }
  const s = new Date(startIso)
  const e = new Date(endIso)
  const startMs = s.getTime()
  const endMs = e.getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return false
  const spanMs = endMs - startMs
  if (spanMs < UTC_DAY_MS || spanMs % UTC_DAY_MS !== 0) return false
  return (
    s.getUTCHours() === 0 &&
    s.getUTCMinutes() === 0 &&
    s.getUTCSeconds() === 0 &&
    s.getUTCMilliseconds() === 0 &&
    e.getUTCHours() === 0 &&
    e.getUTCMinutes() === 0 &&
    e.getUTCSeconds() === 0 &&
    e.getUTCMilliseconds() === 0
  )
}

function symmetricDifferenceSize(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let diff = 0
  for (const id of a) if (!b.has(id)) diff++
  for (const id of b) if (!a.has(id)) diff++
  return diff
}

function sanitizeSuppressedSection(s: HeatmapSectionMetricInput): HeatmapSectionMetricInput {
  return Object.freeze({
    ...s,
    reach_rate: null,
    dwell_center40_ms: null,
    reach_pvs: null,
    dwell_pvs: null,
    ...(s.cta_clicks !== undefined ? { cta_clicks: null } : {}),
    ...(s.sample_size !== undefined ? { sample_size: null } : {}),
    ...(s.pooling_weight !== undefined ? { pooling_weight: null } : {}),
    status: 'suppressed',
  })
}

function sanitizeSuppressedClick(c: HeatmapClickPointInput): HeatmapClickPointInput {
  return Object.freeze({
    ...c,
    rel_x: null,
    rel_y: null,
    click_count: null,
    ...(c.sample_size !== undefined ? { sample_size: null } : {}),
    status: 'suppressed',
  })
}

/**
 * Computes Reduced Row Echelon Form (RREF) of an m x n real matrix in-place on a copy.
 * Returns { rref, pivotCols, rank }.
 */
function computeRref(matrix: readonly (readonly number[])[]): {
  readonly rref: number[][]
  readonly pivotCols: number[]
  readonly rank: number
} {
  const m = matrix.length
  const n = m > 0 ? matrix[0].length : 0
  const a = matrix.map((row) => [...row])
  const pivotCols: number[] = []
  const eps = 1e-9
  let lead = 0

  for (let r = 0; r < m && lead < n; r++) {
    let i = r
    while (lead < n) {
      i = r
      let maxAbs = Math.abs(a[r][lead])
      for (let k = r + 1; k < m; k++) {
        const v = Math.abs(a[k][lead])
        if (v > maxAbs) {
          maxAbs = v
          i = k
        }
      }
      if (maxAbs > eps) break
      lead++
    }
    if (lead >= n) break

    if (i !== r) {
      const tmp = a[r]
      a[r] = a[i]
      a[i] = tmp
    }
    const piv = a[r][lead]
    for (let j = lead; j < n; j++) a[r][j] /= piv
    for (let k = 0; k < m; k++) {
      if (k === r) continue
      const factor = a[k][lead]
      if (Math.abs(factor) <= eps) continue
      for (let j = lead; j < n; j++) {
        a[k][j] -= factor * a[r][j]
      }
    }
    pivotCols.push(lead)
    lead++
  }

  return { rref: a, pivotCols, rank: pivotCols.length }
}

/**
 * Multi-query linear-combination differencing detector (Denning-Schlorer tracker):
 * Partitions observed subjects across queries Q_1..Q_m into disjoint Venn atoms A_1..A_r
 * with exact counts w_j = |A_j| and binary incidence matrix M (m x r).
 * Blocks if ANY non-zero linear combination v = c^T M in row(M) isolates a support S
 * whose total subject count sum_{j in supp(v)} w_j < k (10).
 */
function detectLinearSubjectCombinationLeak(
  subjectSets: readonly ReadonlySet<string>[],
  minK: number,
): string | null {
  const m = subjectSets.length
  if (m < 2) return null

  const allSubjects = new Set<string>()
  for (const s of subjectSets) {
    for (const id of s) allSubjects.add(id)
  }
  if (allSubjects.size === 0) return null

  // Group subjects into disjoint Venn atoms by bitmask signature across the m queries
  const atomWeightsBySig = new Map<string, { weight: number; col: number[] }>()
  for (const subj of allSubjects) {
    const col = new Array<number>(m)
    for (let i = 0; i < m; i++) {
      col[i] = subjectSets[i].has(subj) ? 1 : 0
    }
    const sig = col.join('')
    const existing = atomWeightsBySig.get(sig)
    if (existing) {
      existing.weight += 1
    } else {
      atomWeightsBySig.set(sig, { weight: 1, col })
    }
  }

  const atoms = [...atomWeightsBySig.values()]
  const r = atoms.length
  const M: number[][] = Array.from({ length: m }, () => new Array<number>(r).fill(0))
  for (let j = 0; j < r; j++) {
    for (let i = 0; i < m; i++) {
      M[i][j] = atoms[j].col[i]
    }
  }

  const eps = 1e-9
  const supportWeight = (vec: readonly number[]): number => {
    let w = 0
    for (let j = 0; j < vec.length; j++) {
      if (Math.abs(vec[j]) > eps) w += atoms[j].weight
    }
    return w
  }

  const fullRref = computeRref(M)
  for (let i = 0; i < fullRref.rank; i++) {
    const w = supportWeight(fullRref.rref[i])
    if (w > 0 && w < minK) {
      return DISCLOSURE_BLOCKED_DIFFERENCING
    }
  }

  // Necessary condition for ANY combination supported solely on atoms of weight < minK:
  // rank(M_{:, largeCols}) < rank(M)
  const smallCols: number[] = []
  const largeCols: number[] = []
  let totalSmallWeight = 0
  for (let j = 0; j < r; j++) {
    if (atoms[j].weight < minK) {
      smallCols.push(j)
      totalSmallWeight += atoms[j].weight
    } else {
      largeCols.push(j)
    }
  }
  if (smallCols.length === 0) return null

  const extractSubmatrixRank = (cols: readonly number[]): number => {
    if (cols.length === 0) return 0
    const sub = M.map((row) => cols.map((c) => row[c]))
    return computeRref(sub).rank
  }

  const largeRank = extractSubmatrixRank(largeCols)
  if (largeRank >= fullRref.rank) {
    // Zero non-trivial vectors in row(M) are supported inside smallCols!
    return null
  }

  if (totalSmallWeight < minK) {
    return DISCLOSURE_BLOCKED_DIFFERENCING
  }

  // Check singletons and pairs of small atoms directly via exact rank drop:
  // rank(M_{:, S^c}) < rank(M) iff a non-zero query combination has support inside S.
  for (let a = 0; a < smallCols.length; a++) {
    const colA = smallCols[a]
    const comp = Array.from({ length: r }, (_, idx) => idx).filter((idx) => idx !== colA)
    if (extractSubmatrixRank(comp) < fullRref.rank) {
      return DISCLOSURE_BLOCKED_DIFFERENCING
    }
    for (let b = a + 1; b < smallCols.length; b++) {
      const colB = smallCols[b]
      const pairWeight = atoms[colA].weight + atoms[colB].weight
      if (pairWeight >= minK) continue
      const compPair = Array.from({ length: r }, (_, idx) => idx).filter(
        (idx) => idx !== colA && idx !== colB,
      )
      if (extractSubmatrixRank(compPair) < fullRref.rank) {
        return DISCLOSURE_BLOCKED_DIFFERENCING
      }
    }
  }

  // Also eliminate largeCols first by putting largeCols on the left of [M_large | M_small]
  // so rows >= largeRank form an exact RREF basis of the subspace supported solely on smallCols.
  const orderedCols = [...largeCols, ...smallCols]
  const orderedWeights = orderedCols.map((c) => atoms[c].weight)
  const orderedM = M.map((row) => orderedCols.map((c) => row[c]))
  const subRref = computeRref(orderedM)
  for (let i = largeRank; i < subRref.rank; i++) {
    let w = 0
    for (let j = 0; j < orderedCols.length; j++) {
      if (Math.abs(subRref.rref[i][j]) > eps) w += orderedWeights[j]
    }
    if (w > 0 && w < minK) {
      return DISCLOSURE_BLOCKED_DIFFERENCING
    }
  }

  return null
}

/**
 * Multi-window interval differencing detector when subject_ids are unavailable:
 * Partitions all same-segment query intervals [s_i, e_i) into elementary atomic time slices
 * and checks RREF of [M_time | totals] for any isolated sub-window residual < k (10).
 */
function detectWindowIntervalDifferencingLeak(
  windows: ReadonlyArray<{ readonly startMs: number; readonly endMs: number; readonly total: number }>,
  minK: number,
): string | null {
  const m = windows.length
  if (m < 2) return null

  // Pairwise structural checks on overlapping windows
  for (let i = 0; i < m - 1; i++) {
    const a = windows[i]
    const b = windows[m - 1]
    const overlaps = a.startMs < b.endMs && b.startMs < a.endMs
    if (!overlaps) continue
    const aContainsB = a.startMs <= b.startMs && a.endMs >= b.endMs
    const bContainsA = b.startMs <= a.startMs && b.endMs >= a.endMs
    if (!aContainsB && !bContainsA) {
      // Partially sliding window without subject_ids cannot bound symmetric difference (e.g. equal totals)
      return DISCLOSURE_BLOCKED_DIFFERENCING
    }
    const diff = Math.abs(a.total - b.total)
    if (diff < minK) {
      return DISCLOSURE_BLOCKED_DIFFERENCING
    }
  }

  // Elementary time slice decomposition + RREF across 2+ windows (catches 3+ window subtractions!)
  const endpoints = [...new Set(windows.flatMap((w) => [w.startMs, w.endMs]))].sort((x, y) => x - y)
  const sliceCount = endpoints.length - 1
  if (sliceCount <= 0) return null

  const aug: number[][] = windows.map((w) => {
    const row = new Array<number>(sliceCount + 1).fill(0)
    for (let k = 0; k < sliceCount; k++) {
      if (w.startMs <= endpoints[k] && endpoints[k + 1] <= w.endMs) {
        row[k] = 1
      }
    }
    row[sliceCount] = w.total
    return row
  })

  // Compute RREF on the left `sliceCount` columns while carrying the augmented RHS column
  const mRows = aug.length
  const a = aug.map((r) => [...r])
  const eps = 1e-9
  let lead = 0
  let rank = 0
  for (let r = 0; r < mRows && lead < sliceCount; r++) {
    let i = r
    while (lead < sliceCount) {
      i = r
      let maxAbs = Math.abs(a[r][lead])
      for (let k = r + 1; k < mRows; k++) {
        const v = Math.abs(a[k][lead])
        if (v > maxAbs) {
          maxAbs = v
          i = k
        }
      }
      if (maxAbs > eps) break
      lead++
    }
    if (lead >= sliceCount) break
    if (i !== r) {
      const tmp = a[r]
      a[r] = a[i]
      a[i] = tmp
    }
    const piv = a[r][lead]
    for (let j = lead; j <= sliceCount; j++) a[r][j] /= piv
    for (let k = 0; k < mRows; k++) {
      if (k === r) continue
      const factor = a[k][lead]
      if (Math.abs(factor) <= eps) continue
      for (let j = lead; j <= sliceCount; j++) {
        a[k][j] -= factor * a[r][j]
      }
    }
    rank++
    lead++
  }

  for (let r = 0; r < rank; r++) {
    const rhs = Math.abs(a[r][sliceCount])
    if (rhs < minK - eps) {
      return DISCLOSURE_BLOCKED_DIFFERENCING
    }
  }

  return null
}

interface DisclosureLedgerEntry {
  readonly principal_id: string
  readonly segment_id: string
  readonly period_start_ms: number
  readonly period_end_ms: number
  readonly has_subjects: boolean
  readonly subjects: ReadonlySet<string>
  readonly total: number
}

export class HeatmapDisclosureGuard {
  private readonly maxOverlappingQueries: number
  /** Tracks prior disclosed external-party queries per (tenant, site, page) to stop single- & colluding-principal differencing attacks */
  private readonly history = new Map<string, DisclosureLedgerEntry[]>()

  constructor(options?: { readonly max_overlapping_queries?: number }) {
    this.maxOverlappingQueries =
      options?.max_overlapping_queries ?? DEFAULT_MAX_OVERLAPPING_EXTERNAL_QUERIES
  }

  evaluate(input: DisclosureCheckInput): DisclosureCheckResult {
    // Same-site owner export follows §5.12 without third-party k=10 suppression,
    // while still scrubbing any pre-suppressed cells so raw counts never leak on status='suppressed'.
    if (input.audience === 'site_owner') {
      const ownerSections = input.sections.map((s) =>
        s.status === 'suppressed' ? sanitizeSuppressedSection(s) : s,
      )
      const ownerClicks = input.clicks.map((c) =>
        c.status === 'suppressed' ? sanitizeSuppressedClick(c) : c,
      )
      return Object.freeze({
        allowed: true,
        blocked_differencing_attack: false,
        non_calendar_period_rejected: false,
        suppressed_cell_count: 0,
        sections: Object.freeze(ownerSections),
        clicks: Object.freeze(ownerClicks),
        reason: 'site_owner_self_access',
      })
    }

    // External party rule 1: strict calendar-aligned UTC day period (§11.3 / §11.12)
    if (!isCalendarAlignedIsoRange(input.period_start, input.period_end)) {
      return Object.freeze({
        allowed: false,
        blocked_differencing_attack: false,
        non_calendar_period_rejected: true,
        suppressed_cell_count: input.sections.length + input.clicks.length,
        sections: Object.freeze([]),
        clicks: Object.freeze([]),
        reason: DISCLOSURE_REJECTED_NON_CALENDAR_PERIOD,
      })
    }

    // External party rule 2: segment total must be >= k (10)
    if (input.total_units < EXTERNAL_PARTY_MIN_CELL_K) {
      return Object.freeze({
        allowed: false,
        blocked_differencing_attack: false,
        non_calendar_period_rejected: false,
        suppressed_cell_count: input.sections.length + input.clicks.length,
        sections: Object.freeze([]),
        clicks: Object.freeze([]),
        reason: DISCLOSURE_SUPPRESSED_K_ANONYMITY,
      })
    }

    const currStartMs = Date.parse(input.period_start)
    const currEndMs = Date.parse(input.period_end)
    const currentSet = input.subject_ids ? new Set(input.subject_ids) : null
    const hasCurrentSubjects = currentSet !== null

    // External party rule 3: Sequential & multi-query overlapping differencing attack defense!
    const hKey = `${input.tenant_id}|${input.site_id}|${input.page_url_key}`
    const prior = this.history.get(hKey) ?? []

    const isExactRepeat = prior.some(
      (prev) =>
        prev.segment_id === input.segment_id &&
        prev.period_start_ms === currStartMs &&
        prev.period_end_ms === currEndMs &&
        prev.total === input.total_units &&
        prev.has_subjects === hasCurrentSubjects &&
        (!currentSet ||
          (prev.subjects.size === currentSet.size &&
            symmetricDifferenceSize(prev.subjects, currentSet) === 0)),
    )

    if (!isExactRepeat) {
      const overlappingPrior = prior.filter(
        (prev) => prev.period_start_ms < currEndMs && currStartMs < prev.period_end_ms,
      )
      if (overlappingPrior.length >= this.maxOverlappingQueries) {
        return Object.freeze({
          allowed: false,
          blocked_differencing_attack: true,
          non_calendar_period_rejected: false,
          suppressed_cell_count: input.sections.length + input.clicks.length,
          sections: Object.freeze([]),
          clicks: Object.freeze([]),
          reason: DISCLOSURE_BLOCKED_DIFFERENCING,
        })
      }

      // 3a. Pairwise checks across prior queries (NEVER skip simply because segment_id matches!)
      for (const prev of prior) {
        const windowsOverlap = prev.period_start_ms < currEndMs && currStartMs < prev.period_end_ms
        if (currentSet && prev.has_subjects) {
          const symDiff = symmetricDifferenceSize(prev.subjects, currentSet)
          if (symDiff < EXTERNAL_PARTY_MIN_CELL_K) {
            return Object.freeze({
              allowed: false,
              blocked_differencing_attack: true,
              non_calendar_period_rejected: false,
              suppressed_cell_count: input.sections.length + input.clicks.length,
              sections: Object.freeze([]),
              clicks: Object.freeze([]),
              reason: DISCLOSURE_BLOCKED_DIFFERENCING,
            })
          }
        } else if (windowsOverlap) {
          if (prev.segment_id !== input.segment_id) {
            // Without subject_ids on overlapping windows, different segments (including equal-cardinality swaps |S1|=|S2|=50) cannot prove |S1 △ S2| >= 10
            return Object.freeze({
              allowed: false,
              blocked_differencing_attack: true,
              non_calendar_period_rejected: false,
              suppressed_cell_count: input.sections.length + input.clicks.length,
              sections: Object.freeze([]),
              clicks: Object.freeze([]),
              reason: DISCLOSURE_BLOCKED_DIFFERENCING,
            })
          }
        }
      }

      // 3b. Multi-query (3+ queries) linear-combination tracker over subject sets
      if (currentSet) {
        const priorSets = prior.filter((p) => p.has_subjects).map((p) => p.subjects)
        if (priorSets.length >= 1) {
          const linearLeak = detectLinearSubjectCombinationLeak(
            [...priorSets, currentSet],
            EXTERNAL_PARTY_MIN_CELL_K,
          )
          if (linearLeak) {
            return Object.freeze({
              allowed: false,
              blocked_differencing_attack: true,
              non_calendar_period_rejected: false,
              suppressed_cell_count: input.sections.length + input.clicks.length,
              sections: Object.freeze([]),
              clicks: Object.freeze([]),
              reason: linearLeak,
            })
          }
        }
      }

      // 3c. Same-segment calendar-window shifting & multi-window subtraction tracker
      const sameSegmentPrior = prior.filter((p) => p.segment_id === input.segment_id)
      if (sameSegmentPrior.length >= 1 && (!currentSet || sameSegmentPrior.some((p) => !p.has_subjects))) {
        const windowLeak = detectWindowIntervalDifferencingLeak(
          [
            ...sameSegmentPrior.map((p) => ({
              startMs: p.period_start_ms,
              endMs: p.period_end_ms,
              total: p.total,
            })),
            { startMs: currStartMs, endMs: currEndMs, total: input.total_units },
          ],
          EXTERNAL_PARTY_MIN_CELL_K,
        )
        if (windowLeak) {
          return Object.freeze({
            allowed: false,
            blocked_differencing_attack: true,
            non_calendar_period_rejected: false,
            suppressed_cell_count: input.sections.length + input.clicks.length,
            sections: Object.freeze([]),
            clicks: Object.freeze([]),
            reason: windowLeak,
          })
        }
      }
    }

    // External party rule 4: Primary cell suppression (<10) + Greedy secondary complementary suppression
    // Ensures BOTH suppressed cell count >= 2 AND combined suppressed reach/dwell/click mass >= 10,
    // AND scrubs ALL raw counts (reach_pvs, dwell_pvs, cta_clicks, sample_size, click_count) to null!
    let suppressedCount = 0
    const suppressedSections = new Set<number>()
    input.sections.forEach((s, idx) => {
      const reach = s.reach_pvs ?? 0
      const dwell = s.dwell_pvs ?? 0
      const ctaTooSmall = s.cta_clicks !== undefined && s.cta_clicks !== null && s.cta_clicks < EXTERNAL_PARTY_MIN_CELL_K
      const sampleTooSmall = s.sample_size !== undefined && s.sample_size !== null && s.sample_size < EXTERNAL_PARTY_MIN_CELL_K
      if (
        s.status === 'suppressed' ||
        reach < EXTERNAL_PARTY_MIN_CELL_K ||
        dwell < EXTERNAL_PARTY_MIN_CELL_K ||
        ctaTooSmall ||
        sampleTooSmall
      ) {
        suppressedSections.add(idx)
      }
    })

    if (suppressedSections.size > 0 && input.sections.length >= 2) {
      const sumSuppressed = () => {
        let reachSum = 0
        let dwellSum = 0
        for (const idx of suppressedSections) {
          reachSum += input.sections[idx].reach_pvs ?? 0
          dwellSum += input.sections[idx].dwell_pvs ?? 0
        }
        return { reachSum, dwellSum }
      }
      while (suppressedSections.size < input.sections.length) {
        const { reachSum, dwellSum } = sumSuppressed()
        if (
          suppressedSections.size >= 2 &&
          reachSum >= EXTERNAL_PARTY_MIN_CELL_K &&
          dwellSum >= EXTERNAL_PARTY_MIN_CELL_K
        ) {
          break
        }
        let minIdx = -1
        let minPvs = Infinity
        input.sections.forEach((s, idx) => {
          if (suppressedSections.has(idx)) return
          const score = Math.min(s.reach_pvs ?? 0, s.dwell_pvs ?? 0)
          if (score < minPvs) {
            minPvs = score
            minIdx = idx
          }
        })
        if (minIdx === -1) break
        suppressedSections.add(minIdx)
      }
    }

    const safeSections = input.sections.map((s, idx): HeatmapSectionMetricInput => {
      if (suppressedSections.has(idx)) {
        suppressedCount++
        return sanitizeSuppressedSection(s)
      }
      return s
    })

    const suppressedClicks = new Set<number>()
    input.clicks.forEach((c, idx) => {
      const cnt = c.click_count ?? 0
      const sampleTooSmall =
        c.sample_size !== undefined && c.sample_size !== null && c.sample_size < EXTERNAL_PARTY_MIN_CELL_K
      if (c.status === 'suppressed' || cnt < EXTERNAL_PARTY_MIN_CELL_K || sampleTooSmall) {
        suppressedClicks.add(idx)
      }
    })

    if (suppressedClicks.size > 0 && input.clicks.length >= 2) {
      const sumClickCounts = () => {
        let sum = 0
        for (const idx of suppressedClicks) {
          sum += input.clicks[idx].click_count ?? 0
        }
        return sum
      }
      while (suppressedClicks.size < input.clicks.length) {
        if (suppressedClicks.size >= 2 && sumClickCounts() >= EXTERNAL_PARTY_MIN_CELL_K) {
          break
        }
        let minIdx = -1
        let minCnt = Infinity
        input.clicks.forEach((c, idx) => {
          if (suppressedClicks.has(idx)) return
          const cnt = c.click_count ?? 0
          if (cnt < minCnt) {
            minCnt = cnt
            minIdx = idx
          }
        })
        if (minIdx === -1) break
        suppressedClicks.add(minIdx)
      }
    }

    const safeClicks = input.clicks.map((c, idx): HeatmapClickPointInput => {
      if (suppressedClicks.has(idx)) {
        suppressedCount++
        return sanitizeSuppressedClick(c)
      }
      return c
    })

    // Record query into differencing guard ledger (unless exact idempotent repeat)
    if (!isExactRepeat) {
      prior.push({
        principal_id: input.principal_id,
        segment_id: input.segment_id,
        period_start_ms: currStartMs,
        period_end_ms: currEndMs,
        has_subjects: hasCurrentSubjects,
        subjects: currentSet ?? new Set(),
        total: input.total_units,
      })
      this.history.set(hKey, prior)
    }

    return Object.freeze({
      allowed: true,
      blocked_differencing_attack: false,
      non_calendar_period_rejected: false,
      suppressed_cell_count: suppressedCount,
      sections: Object.freeze(safeSections),
      clicks: Object.freeze(safeClicks),
      reason: suppressedCount > 0 ? 'k10_with_complementary_suppression' : 'disclosed',
    })
  }
}

// ---------------------------------------------------------------------------
// 3. Cost Reservation & Abuse Limiter (§11.12)
// ---------------------------------------------------------------------------

export interface HeatmapCostLimits {
  readonly max_concurrent_jobs_per_principal: number
  readonly max_total_pixels_per_tenant_window: number
  readonly max_images_per_request: number
  readonly max_retries_per_job: number
}

export const DEFAULT_HEATMAP_COST_LIMITS: HeatmapCostLimits = Object.freeze({
  max_concurrent_jobs_per_principal: 4,
  max_total_pixels_per_tenant_window: 20_000_000,
  max_images_per_request: 10,
  max_retries_per_job: 2,
})

// ---------------------------------------------------------------------------
// 4. Heatmap Render Service (Unified REST & MCP Core)
// ---------------------------------------------------------------------------

export interface HeatmapRenderRequest {
  readonly tenant_id: string
  readonly site_id: string
  readonly page_url: string
  readonly period_start: string
  readonly period_end: string
  readonly device_class: HeatmapDeviceClass
  readonly kind: HeatmapKind
  readonly lane?: HeatmapDataLane
  readonly actor_bucket: HeatmapActorBucket
  readonly verdict_version: string
  readonly segment_id: string
  readonly consent_mode: HeatmapConsentMode
  readonly granted_purposes: readonly HeatmapConsentPurpose[]
  readonly jurisdiction: HeatmapJurisdiction
  readonly sdk_capability: HeatmapSdkCapability
  readonly custom_event_mapped_to_page_version_position?: boolean
  readonly requested_metric_keys?: readonly string[]
  readonly requested_input_features?: ReadonlyArray<{
    readonly key: string
    readonly provenance: 'observed' | 'derived_deterministic' | 'model_inferred'
  }>
  readonly model_inferred_header?: {
    readonly likelihood_ratio: number
    readonly fpr_upper_bound: number
    readonly certificate_id: string
    readonly certified?: boolean
    readonly ai_probability?: never
  } | null
  /** One or more unit datasets (when versions/variants changed in period, split per unit!) */
  readonly unit_datasets: readonly HeatmapUnitDataset[]
  readonly custom_display_label?: string
  readonly requested_at: string
}

export interface RenderedHeatmapUnitArtifact {
  readonly artifact_id: string
  readonly unit_key: string
  readonly status: MeasureStatus
  readonly render_kind: HeatmapRenderKind
  readonly pending_job_id: string | null
  readonly display_label: string
  readonly reproducibility_hash: string
  readonly png_base64: string | null
  readonly png_sha256: string | null
  readonly svg_markup: string | null
  readonly width: number
  readonly height: number
  readonly screenshot_snapshot_id: string | null
  readonly screenshot_captured_at: string | null
  readonly redaction_count: number
  readonly geometry_drift_G: number | null
  readonly verdict_version: string
  readonly actor_bucket: HeatmapActorBucket
  readonly model_inferred_disclosure: ModelInferredDisclosureHeader | null
  readonly sections: readonly HeatmapSectionMetricInput[]
  readonly clicks: readonly HeatmapClickPointInput[]
  readonly untrusted_embedded_texts: readonly UntrustedValue[]
  readonly cache_hit: boolean
  readonly deletion_epoch: number
  readonly build_seq: number
  readonly envelope: SerializedResponseEnvelope
}

export interface HeatmapRenderResponse {
  readonly http_status: 200 | 202 | 400 | 401 | 403 | 404 | 410 | 429
  readonly ok: boolean
  readonly error?: string
  readonly tenant_id: string
  readonly site_id: string
  readonly page_url_key: string
  readonly kind: HeatmapKind
  readonly lane: HeatmapDataLane
  readonly split_unit_count: number
  readonly artifacts: readonly RenderedHeatmapUnitArtifact[]
  readonly limitations: readonly string[]
  readonly residency: ResidencyBlock
  /** Security invariant: embedded image/OCR text cannot mutate auth/destination/cost budget */
  readonly untrusted_boundary_enforced: true
}

interface StoredArtifactEntry {
  readonly artifact: RenderedHeatmapUnitArtifact
  readonly tenant_id: string
  readonly site_id: string
  readonly page_url_key: string
  readonly audience: 'site_owner' | 'external_party'
  readonly disclosure_input: DisclosureCheckInput
  readonly png_bytes: Uint8Array | null
  readonly deletion_epoch: number
  readonly build_seq: number
}

interface InvalidatedArtifactTombstone {
  readonly tenant_id: string
  readonly site_id: string
  readonly page_url_key: string
  readonly reason: 'artifact_invalidated_by_deletion' | 'artifact_invalidated_by_rebuild'
}

export class HeatmapRenderService {
  public readonly auditLog: AuditLogStore
  public readonly disclosureGuard: HeatmapDisclosureGuard
  private readonly limits: HeatmapCostLimits
  private readonly tenantRevocationEpochs = new Map<string, number>()
  private readonly deletionEpochs = new Map<string, number>() // tenant|site|url -> epoch
  private readonly buildSeqs = new Map<string, number>() // tenant|site|url -> seq
  private readonly artifactsById = new Map<string, StoredArtifactEntry>()
  private readonly artifactsByReproHash = new Map<string, StoredArtifactEntry>()
  private readonly invalidatedArtifactTombstones = new Map<string, InvalidatedArtifactTombstone>()
  private readonly tenantPixelsUsed = new Map<string, number>()
  private readonly principalActiveJobs = new Map<string, number>()

  constructor(options?: {
    readonly auditLog?: AuditLogStore
    readonly disclosureGuard?: HeatmapDisclosureGuard
    readonly limits?: HeatmapCostLimits
    readonly residency?: ResidencyBlock
  }) {
    this.auditLog = options?.auditLog ?? new AuditLogStore()
    this.disclosureGuard = options?.disclosureGuard ?? new HeatmapDisclosureGuard()
    this.limits = options?.limits ?? DEFAULT_HEATMAP_COST_LIMITS
    this.defaultResidency = options?.residency ?? {
      storage_region: 'jp-tokyo',
      processing_region: 'jp-tokyo',
    }
  }

  private readonly defaultResidency: ResidencyBlock

  private pageScopeKey(tenantId: string, siteId: string, urlKey: string): string {
    return `${tenantId}|${siteId}|${urlKey}`
  }

  setTenantRevocationEpoch(tenantId: string, epoch: number): void {
    this.tenantRevocationEpochs.set(tenantId, epoch)
  }

  /**
   * 削除イベント発生時: 世代を進めて派生画像・キャッシュ・ID保持エントリを即時物理消去する (§11.12)。
   */
  invalidateOnDeletion(tenantId: string, siteId: string, pageUrlOrKey: string): number {
    const urlKey = pageUrlOrKey.includes('://')
      ? computeUrlKeyV2(pageUrlOrKey).url_key_v2
      : pageUrlOrKey
    const pk = this.pageScopeKey(tenantId, siteId, urlKey)
    const nextEpoch = (this.deletionEpochs.get(pk) ?? 0) + 1
    this.deletionEpochs.set(pk, nextEpoch)
    this.evictStaleArtifacts(tenantId, siteId, urlKey, 'artifact_invalidated_by_deletion')
    return nextEpoch
  }

  /** Alias for deletion event notification (§11.12). */
  recordDeletionEvent(tenantId: string, siteId: string, pageUrlOrKey: string): number {
    return this.invalidateOnDeletion(tenantId, siteId, pageUrlOrKey)
  }

  /**
   * 集計再構築 (`build_seq` 更新) 時: 派生画像・キャッシュ・ID保持エントリを即時物理消去する (§11.12)。
   */
  invalidateOnRebuild(tenantId: string, siteId: string, pageUrlOrKey: string): number {
    const urlKey = pageUrlOrKey.includes('://')
      ? computeUrlKeyV2(pageUrlOrKey).url_key_v2
      : pageUrlOrKey
    const pk = this.pageScopeKey(tenantId, siteId, urlKey)
    const nextSeq = (this.buildSeqs.get(pk) ?? 1) + 1
    this.buildSeqs.set(pk, nextSeq)
    this.evictStaleArtifacts(tenantId, siteId, urlKey, 'artifact_invalidated_by_rebuild')
    return nextSeq
  }

  /** Alias for explicit or incremental build_seq update (§11.12). */
  recordRebuildSeq(
    tenantId: string,
    siteId: string,
    pageUrlOrKey: string,
    explicitSeq?: number,
  ): number {
    const urlKey = pageUrlOrKey.includes('://')
      ? computeUrlKeyV2(pageUrlOrKey).url_key_v2
      : pageUrlOrKey
    const pk = this.pageScopeKey(tenantId, siteId, urlKey)
    const cur = this.buildSeqs.get(pk) ?? 1
    const nextSeq = explicitSeq !== undefined && explicitSeq > cur ? explicitSeq : cur + 1
    this.buildSeqs.set(pk, nextSeq)
    this.evictStaleArtifacts(tenantId, siteId, urlKey, 'artifact_invalidated_by_rebuild')
    return nextSeq
  }

  private evictStaleArtifacts(
    tenantId: string,
    siteId: string,
    urlKey: string,
    reason: 'artifact_invalidated_by_deletion' | 'artifact_invalidated_by_rebuild',
  ): void {
    for (const [hash, entry] of this.artifactsByReproHash.entries()) {
      if (
        entry.tenant_id === tenantId &&
        entry.site_id === siteId &&
        entry.page_url_key === urlKey
      ) {
        entry.png_bytes?.fill(0)
        this.artifactsByReproHash.delete(hash)
      }
    }
    for (const [id, entry] of this.artifactsById.entries()) {
      if (
        entry.tenant_id === tenantId &&
        entry.site_id === siteId &&
        entry.page_url_key === urlKey
      ) {
        entry.png_bytes?.fill(0)
        this.artifactsById.delete(id)
        this.invalidatedArtifactTombstones.set(id, {
          tenant_id: tenantId,
          site_id: siteId,
          page_url_key: urlKey,
          reason,
        })
      }
    }
  }

  /**
   * 取得毎認証 (§11.12):
   * 署名付き URL 単独アクセスを禁止し、毎回テナント・サイト・権限・失効エポックを照合する。
   * 別テナントへのアクセスは 404 + 監査ログ行 (§11.9)。
   */
  authorizeArtifactFetch(params: {
    readonly principal: HeatmapFetchPrincipal | null
    readonly target_tenant_id: string
    readonly target_site_id: string
    readonly action: string
    readonly resource_id: string
    readonly signed_url_token_only?: boolean
    readonly now_iso: string
  }): AuthCheckResult {
    if (params.signed_url_token_only || !params.principal) {
      this.auditLog.append({
        timestamp: params.now_iso,
        tenantId: params.target_tenant_id,
        targetTenantId: params.target_tenant_id,
        principalId: 'anonymous',
        credentialKind: 'ugk_pub',
        credentialId: 'none',
        action: params.action,
        riskClass: 'R0',
        resourceType: 'heatmap_artifact',
        resourceId: params.resource_id,
        outcome: 'deny_401',
        reason: params.signed_url_token_only
          ? 'signed_url_only_prohibited'
          : 'unauthenticated_request',
      })
      return Object.freeze({
        allowed: false,
        http_status: 401,
        reason: params.signed_url_token_only
          ? 'signed_url_only_prohibited'
          : 'unauthenticated_request',
      })
    }

    const p = params.principal
    // Foreign tenant -> ALWAYS 404 + audit log row (§11.9)
    if (p.tenant_id !== params.target_tenant_id) {
      this.auditLog.append({
        timestamp: params.now_iso,
        tenantId: p.tenant_id,
        targetTenantId: params.target_tenant_id,
        principalId: p.principal_id,
        credentialKind: 'ugk_sec',
        credentialId: p.principal_id,
        action: params.action,
        riskClass: 'R0',
        resourceType: 'heatmap_artifact',
        resourceId: params.resource_id,
        outcome: 'deny_404',
        reason: 'foreign_tenant_not_found',
      })
      return Object.freeze({
        allowed: false,
        http_status: 404,
        reason: 'foreign_tenant_not_found',
      })
    }

    const liveEpoch = this.tenantRevocationEpochs.get(p.tenant_id) ?? 0
    if (p.disabled || p.token_revocation_epoch < liveEpoch) {
      this.auditLog.append({
        timestamp: params.now_iso,
        tenantId: p.tenant_id,
        targetTenantId: params.target_tenant_id,
        principalId: p.principal_id,
        credentialKind: 'ugk_sec',
        credentialId: p.principal_id,
        action: params.action,
        riskClass: 'R0',
        resourceType: 'heatmap_artifact',
        resourceId: params.resource_id,
        outcome: 'deny_401',
        reason: 'principal_revoked_or_disabled',
      })
      return Object.freeze({
        allowed: false,
        http_status: 401,
        reason: 'principal_revoked_or_disabled',
      })
    }

    if (
      (p.allowed_site_ids !== '*' && !p.allowed_site_ids.includes(params.target_site_id)) ||
      !p.scopes.includes('analytics:read')
    ) {
      this.auditLog.append({
        timestamp: params.now_iso,
        tenantId: p.tenant_id,
        targetTenantId: params.target_tenant_id,
        principalId: p.principal_id,
        credentialKind: 'ugk_sec',
        credentialId: p.principal_id,
        action: params.action,
        riskClass: 'R0',
        resourceType: 'heatmap_artifact',
        resourceId: params.resource_id,
        outcome: 'deny_403',
        reason: 'missing_site_or_analytics_read_scope',
      })
      return Object.freeze({
        allowed: false,
        http_status: 403,
        reason: 'missing_site_or_analytics_read_scope',
      })
    }

    return Object.freeze({ allowed: true, http_status: 200, reason: 'authorized' })
  }

  /**
   * 保存済み成果物の取得（毎回認証＋Audience隔離＋差分防御＋削除/再集計世代の再確認）。
   */
  fetchArtifactById(params: {
    readonly principal: HeatmapFetchPrincipal | null
    readonly artifact_id: string
    readonly target_site_id?: string
    readonly signed_url_token_only?: boolean
    readonly now_iso: string
  }): {
    readonly http_status: 200 | 401 | 403 | 404 | 410
    readonly artifact: RenderedHeatmapUnitArtifact | null
    readonly png_bytes: Uint8Array | null
    readonly reason: string
  } {
    // 1. Check unauthenticated / signed_url_token_only FIRST to prevent artifact existence oracle!
    if (params.signed_url_token_only || !params.principal) {
      const reason = params.signed_url_token_only
        ? 'signed_url_only_prohibited'
        : 'unauthenticated_request'
      this.auditLog.append({
        timestamp: params.now_iso,
        tenantId: 'anonymous',
        targetTenantId: 'unknown',
        principalId: 'anonymous',
        credentialKind: 'ugk_pub',
        credentialId: 'none',
        action: 'heatmap.fetch_artifact',
        riskClass: 'R0',
        resourceType: 'heatmap_artifact',
        resourceId: params.artifact_id,
        outcome: 'deny_401',
        reason,
      })
      return Object.freeze({
        http_status: 401,
        artifact: null,
        png_bytes: null,
        reason,
      })
    }

    const entry = this.artifactsById.get(params.artifact_id)
    const tombstone = !entry ? this.invalidatedArtifactTombstones.get(params.artifact_id) : undefined
    if (!entry && !tombstone) {
      return Object.freeze({
        http_status: 404,
        artifact: null,
        png_bytes: null,
        reason: 'artifact_not_found',
      })
    }

    const targetTenantId = entry ? entry.tenant_id : tombstone!.tenant_id
    const targetSiteId = entry ? entry.site_id : tombstone!.site_id

    const auth = this.authorizeArtifactFetch({
      principal: params.principal,
      target_tenant_id: targetTenantId,
      target_site_id: targetSiteId,
      action: 'heatmap.fetch_artifact',
      resource_id: params.artifact_id,
      signed_url_token_only: params.signed_url_token_only,
      now_iso: params.now_iso,
    })
    if (!auth.allowed) {
      return Object.freeze({
        http_status: auth.http_status,
        artifact: null,
        png_bytes: null,
        reason: auth.reason,
      })
    }

    if (params.target_site_id !== undefined && params.target_site_id !== targetSiteId) {
      this.auditLog.append({
        timestamp: params.now_iso,
        tenantId: params.principal.tenant_id,
        targetTenantId,
        principalId: params.principal.principal_id,
        credentialKind: 'ugk_sec',
        credentialId: params.principal.principal_id,
        action: 'heatmap.fetch_artifact',
        riskClass: 'R0',
        resourceType: 'heatmap_artifact',
        resourceId: params.artifact_id,
        outcome: 'deny_403',
        reason: 'target_site_id_mismatch',
      })
      return Object.freeze({
        http_status: 403,
        artifact: null,
        png_bytes: null,
        reason: 'target_site_id_mismatch',
      })
    }

    if (tombstone) {
      return Object.freeze({
        http_status: 410,
        artifact: null,
        png_bytes: null,
        reason: tombstone.reason,
      })
    }

    // Re-check deletion_epoch & build_seq on every fetch (and before pending job publish!)
    const pk = this.pageScopeKey(entry!.tenant_id, entry!.site_id, entry!.page_url_key)
    const curDelEpoch = this.deletionEpochs.get(pk) ?? 0
    const curBuildSeq = this.buildSeqs.get(pk) ?? 1
    if (entry!.deletion_epoch < curDelEpoch || entry!.build_seq < curBuildSeq) {
      const reason =
        entry!.deletion_epoch < curDelEpoch
          ? 'artifact_invalidated_by_deletion'
          : 'artifact_invalidated_by_rebuild'
      entry!.png_bytes?.fill(0)
      this.artifactsById.delete(params.artifact_id)
      this.invalidatedArtifactTombstones.set(params.artifact_id, {
        tenant_id: entry!.tenant_id,
        site_id: entry!.site_id,
        page_url_key: entry!.page_url_key,
        reason,
      })
      return Object.freeze({
        http_status: 410,
        artifact: null,
        png_bytes: null,
        reason,
      })
    }

    // Audience isolation: external_party MUST NEVER read an unredacted site_owner artifact!
    if (params.principal.audience === 'external_party') {
      if (entry!.audience !== 'external_party') {
        this.auditLog.append({
          timestamp: params.now_iso,
          tenantId: params.principal.tenant_id,
          targetTenantId,
          principalId: params.principal.principal_id,
          credentialKind: 'ugk_sec',
          credentialId: params.principal.principal_id,
          action: 'heatmap.fetch_artifact',
          riskClass: 'R0',
          resourceType: 'heatmap_artifact',
          resourceId: params.artifact_id,
          outcome: 'deny_403',
          reason: 'audience_mismatch_redaction_required',
        })
        return Object.freeze({
          http_status: 403,
          artifact: null,
          png_bytes: null,
          reason: 'audience_mismatch_redaction_required',
        })
      }

      // Re-verify sequential differencing guard for external_party fetches
      const fetchDisclosure = this.disclosureGuard.evaluate({
        ...entry!.disclosure_input,
        principal_id: params.principal.principal_id,
        audience: 'external_party',
      })
      if (!fetchDisclosure.allowed) {
        return Object.freeze({
          http_status: 403,
          artifact: null,
          png_bytes: null,
          reason: fetchDisclosure.reason,
        })
      }
    }

    return Object.freeze({
      http_status: 200,
      artifact: entry!.artifact,
      png_bytes: entry!.png_bytes,
      reason: 'ok',
    })
  }

  /**
   * メイン操作: ヒートマップを絵＋元数字＋版＋共通返答形式で生成・返却する (§11.12)。
   */
  renderHeatmap(
    principal: HeatmapFetchPrincipal | null,
    req: HeatmapRenderRequest,
  ): HeatmapRenderResponse {
    const lane: HeatmapDataLane = req.lane ?? 'standard_telemetry'
    const urlKey = computeUrlKeyV2(req.page_url).url_key_v2
    const displayLabel = req.custom_display_label ?? HEATMAP_KIND_DISPLAY_NAMES[req.kind]

    // 1. Validate forbidden dwell labels ("注目" / "視線" / "要素注意" prohibited!)
    assertValidHeatmapDisplayLabel(req.kind, displayLabel)

    // 2. Per-request authorization
    const auth = this.authorizeArtifactFetch({
      principal,
      target_tenant_id: req.tenant_id,
      target_site_id: req.site_id,
      action: 'heatmap.render',
      resource_id: urlKey,
      now_iso: req.requested_at,
    })
    if (!auth.allowed || !principal) {
      const errStatus = auth.http_status === 200 ? 401 : auth.http_status
      return this.errorResponse(errStatus, auth.reason, req, urlKey, lane)
    }

    // 3. Validate PNG dimensions BEFORE pixel budget arithmetic & cost reservation (§11.12)
    for (const d of req.unit_datasets) {
      if (d.screenshot) {
        assertValidPngDimensions(d.screenshot.width, d.screenshot.height)
      }
    }

    if (req.unit_datasets.length > this.limits.max_images_per_request) {
      return this.errorResponse(429, 'max_images_per_request_exceeded', req, urlKey, lane)
    }
    const activeCount = this.principalActiveJobs.get(principal.principal_id) ?? 0
    if (activeCount >= this.limits.max_concurrent_jobs_per_principal) {
      return this.errorResponse(429, 'max_concurrent_jobs_exceeded', req, urlKey, lane)
    }
    const requestedPixels = req.unit_datasets.reduce((acc, d) => {
      const w = d.screenshot?.width ?? 320
      const h = d.screenshot?.height ?? 480
      return acc + w * h
    }, 0)
    const usedPixels = this.tenantPixelsUsed.get(req.tenant_id) ?? 0
    if (usedPixels + requestedPixels > this.limits.max_total_pixels_per_tenant_window) {
      return this.errorResponse(429, 'tenant_pixel_budget_exceeded', req, urlKey, lane)
    }

    // 4. Actor bucket policy check (model_inferred LR+FPR & non-classifier features / http_crawler facts only)
    const actorPolicy = validateActorBucketForHeatmap({
      bucket: req.actor_bucket,
      kind: req.kind,
      verdict_version: req.verdict_version,
      requested_metric_keys: req.requested_metric_keys,
      input_feature_provenances: req.requested_input_features,
      model_inferred_header: req.model_inferred_header,
    })
    if (!actorPolicy.allowed) {
      return this.errorResponse(
        400,
        actorPolicy.rejection_reason ?? 'actor_policy_rejected',
        req,
        urlKey,
        lane,
      )
    }

    this.principalActiveJobs.set(principal.principal_id, activeCount + 1)
    try {
      const pk = this.pageScopeKey(req.tenant_id, req.site_id, urlKey)
      const curDelEpoch = this.deletionEpochs.get(pk) ?? 0
      const curBuildSeq = this.buildSeqs.get(pk) ?? 1

      const allLimitations = new Set<string>()
      const artifacts: RenderedHeatmapUnitArtifact[] = []
      let anyPending = false
      let anyDifferencingBlocked = false

      // 5. Split strictly by HeatmapUnitKey — NEVER blend different versions/variants into 1 image!
      for (const dataset of req.unit_datasets) {
        const consentEval = evaluateHeatmapConsentEligibility({
          kind: req.kind,
          lane,
          consent_mode: req.consent_mode,
          granted_purposes: req.granted_purposes,
          jurisdiction: req.jurisdiction,
          sdk_capability: req.sdk_capability,
          custom_event_mapped_to_page_version_position:
            req.custom_event_mapped_to_page_version_position,
          contains_video_or_canvas: dataset.contains_video_or_canvas,
          contains_cross_origin_iframe: dataset.contains_cross_origin_iframe,
          is_authenticated_or_personalized_page: dataset.is_authenticated_or_personalized_page,
        })
        consentEval.limitations.forEach((l) => allLimitations.add(l))

        // Emit ONLY OCR snippets with verified post-mask provenance (from_masked_image: true,
        // overlaps_masked_region !== true, and outside redaction_boxes), wrapped as UntrustedValue.
        const untrustedEmbeddedTexts: UntrustedValue[] = extractSafePostMaskOcrTexts(
          dataset.screenshot,
        )

        const unitKeyStr = serializeHeatmapUnitKey(dataset.unit)
        const reproScope = {
          tenant_id: req.tenant_id,
          site_id: req.site_id,
          audience: principal.audience,
          period_start: req.period_start,
          period_end: req.period_end,
          segment_id: req.segment_id,
        }

        // Unified disclosure & differencing attack check MUST run BEFORE any cache lookup!
        const disclosureInput: DisclosureCheckInput = {
          principal_id: principal.principal_id,
          tenant_id: req.tenant_id,
          site_id: req.site_id,
          page_url_key: urlKey,
          audience: principal.audience,
          period_start: req.period_start,
          period_end: req.period_end,
          segment_id: req.segment_id,
          total_units: dataset.total_units_in_segment,
          subject_ids: dataset.subject_ids,
          sections: dataset.sections,
          clicks: dataset.clicks,
        }
        const disclosure = this.disclosureGuard.evaluate(disclosureInput)

        const metricsDigest = createHash('sha256')
          .update(
            JSON.stringify({
              dom_state: dataset.dom_state,
              drift_G: dataset.measured_geometry_drift_G,
              claim_gate_passed: dataset.claim_gate_passed,
              has_verified_field_layout: dataset.has_verified_field_layout,
              is_auth_page: Boolean(dataset.is_authenticated_or_personalized_page),
              pending_job_id: dataset.lab_render_pending_job_id ?? null,
              screenshot_provenance: dataset.screenshot?.provenance ?? null,
              sections: disclosure.sections,
              clicks: disclosure.clicks,
              http: dataset.http_fetch_metrics ?? null,
              consent: consentEval.status,
              audience: principal.audience,
              disclosure_allowed: disclosure.allowed,
            }),
          )
          .digest('hex')
        const reproHash = computeReproducibilityHash(
          dataset.unit,
          req.kind,
          req.actor_bucket,
          dataset.repro_inputs,
          metricsDigest,
          reproScope,
        )

        if (!disclosure.allowed) {
          if (disclosure.blocked_differencing_attack) anyDifferencingBlocked = true
          const supArt = this.buildNonImageArtifact({
            req,
            audience: principal.audience,
            urlKey,
            dataset,
            unitKeyStr,
            reproHash,
            status: 'suppressed',
            renderKind: 'none',
            pendingJobId: null,
            displayLabel,
            modelDisclosure: actorPolicy.model_inferred_disclosure,
            untrustedEmbeddedTexts,
            deletionEpoch: curDelEpoch,
            buildSeq: curBuildSeq,
            reason: disclosure.reason,
          })
          artifacts.push(supArt)
          continue
        }

        if (!consentEval.eligible) {
          const nonEligArt = this.buildNonImageArtifact({
            req,
            audience: principal.audience,
            urlKey,
            dataset,
            unitKeyStr,
            reproHash,
            status: consentEval.status,
            renderKind: 'none',
            pendingJobId: null,
            displayLabel,
            modelDisclosure: actorPolicy.model_inferred_disclosure,
            untrustedEmbeddedTexts,
            deletionEpoch: curDelEpoch,
            buildSeq: curBuildSeq,
            reason: consentEval.reason,
          })
          artifacts.push(nonEligArt)
          continue
        }

        // Reuse cached deterministic artifact ONLY AFTER disclosure & consent checks pass,
        // keyed strictly by tenant, site, audience, window, segment, and reproHash!
        const cacheKey = `${req.tenant_id}|${req.site_id}|${principal.audience}|${req.period_start}|${req.period_end}|${req.segment_id}|${reproHash}`
        const cached = this.artifactsByReproHash.get(cacheKey)
        if (
          cached &&
          cached.audience === principal.audience &&
          cached.deletion_epoch === curDelEpoch &&
          cached.build_seq === curBuildSeq
        ) {
          artifacts.push(Object.freeze({ ...cached.artifact, cache_hit: true }))
          continue
        }

        // Overlay vs wireframe vs http_fetch vs none/pending decision
        const kindDecision = decideHeatmapRenderKind(dataset, req.actor_bucket)
        if (kindDecision.render_kind === 'none') {
          if (kindDecision.status === 'pending') anyPending = true
          const noImgArt = this.buildNonImageArtifact({
            req,
            audience: principal.audience,
            urlKey,
            dataset,
            unitKeyStr,
            reproHash,
            status: kindDecision.status,
            renderKind: 'none',
            pendingJobId: kindDecision.pending_job_id,
            displayLabel,
            modelDisclosure: actorPolicy.model_inferred_disclosure,
            untrustedEmbeddedTexts,
            deletionEpoch: curDelEpoch,
            buildSeq: curBuildSeq,
            reason: kindDecision.reasons.join(';'),
          })
          artifacts.push(noImgArt)
          continue
        }

        // Render deterministic PNG + SVG
        const rendered = renderDeterministicHeatmapImage({
          render_kind: kindDecision.render_kind,
          kind: req.kind,
          dataset,
          sections: disclosure.sections,
          clicks: disclosure.clicks,
          http_fetch: dataset.http_fetch_metrics,
        })

        // Charge pixel budget upon actual render
        this.tenantPixelsUsed.set(
          req.tenant_id,
          (this.tenantPixelsUsed.get(req.tenant_id) ?? 0) + rendered.width * rendered.height,
        )

        const envelope = this.buildUnitEnvelope({
          req,
          audience: principal.audience,
          suppressedCellCount: disclosure.suppressed_cell_count,
          urlKey,
          dataset,
          status: 'ok',
          renderKind: kindDecision.render_kind,
          sections: disclosure.sections,
          clicks: disclosure.clicks,
          reproHash,
          limitations: [...allLimitations],
        })

        const artifactId = `hm_${reproHash.slice(0, 16)}_${curDelEpoch}_${curBuildSeq}`
        const artifact: RenderedHeatmapUnitArtifact = Object.freeze({
          artifact_id: artifactId,
          unit_key: unitKeyStr,
          status: 'ok',
          render_kind: kindDecision.render_kind,
          pending_job_id: null,
          display_label: displayLabel,
          reproducibility_hash: reproHash,
          png_base64: Buffer.from(rendered.png_bytes).toString('base64'),
          png_sha256: rendered.png_sha256,
          svg_markup: rendered.svg_markup,
          width: rendered.width,
          height: rendered.height,
          screenshot_snapshot_id: dataset.screenshot?.snapshot_id ?? null,
          screenshot_captured_at: dataset.screenshot?.captured_at ?? null,
          redaction_count: rendered.redaction_count,
          geometry_drift_G: dataset.measured_geometry_drift_G,
          verdict_version: req.verdict_version,
          actor_bucket: req.actor_bucket,
          model_inferred_disclosure: actorPolicy.model_inferred_disclosure,
          sections: disclosure.sections,
          clicks: disclosure.clicks,
          untrusted_embedded_texts: Object.freeze(untrustedEmbeddedTexts),
          cache_hit: false,
          deletion_epoch: curDelEpoch,
          build_seq: curBuildSeq,
          envelope,
        })

        // Re-check live generation before publishing to cache/store (§11.12)
        const postRenderDelEpoch = this.deletionEpochs.get(pk) ?? 0
        const postRenderBuildSeq = this.buildSeqs.get(pk) ?? 1
        if (postRenderDelEpoch === curDelEpoch && postRenderBuildSeq === curBuildSeq) {
          const entry: StoredArtifactEntry = {
            artifact,
            tenant_id: req.tenant_id,
            site_id: req.site_id,
            page_url_key: urlKey,
            audience: principal.audience,
            disclosure_input: disclosureInput,
            png_bytes: rendered.png_bytes,
            deletion_epoch: curDelEpoch,
            build_seq: curBuildSeq,
          }
          this.artifactsById.set(artifactId, entry)
          this.artifactsByReproHash.set(cacheKey, entry)
        }
        artifacts.push(artifact)
      }

      return Object.freeze({
        http_status: anyDifferencingBlocked ? 403 : anyPending ? 202 : 200,
        ok: !anyDifferencingBlocked,
        ...(anyDifferencingBlocked ? { error: 'differencing_attack_blocked' } : {}),
        tenant_id: req.tenant_id,
        site_id: req.site_id,
        page_url_key: urlKey,
        kind: req.kind,
        lane,
        split_unit_count: artifacts.length,
        artifacts: Object.freeze(artifacts),
        limitations: Object.freeze([...allLimitations]),
        residency: this.defaultResidency,
        untrusted_boundary_enforced: true,
      })
    } finally {
      this.principalActiveJobs.set(principal.principal_id, activeCount)
    }
  }

  private buildNonImageArtifact(params: {
    readonly req: HeatmapRenderRequest
    readonly audience: 'site_owner' | 'external_party'
    readonly urlKey: string
    readonly dataset: HeatmapUnitDataset
    readonly unitKeyStr: string
    readonly reproHash: string
    readonly status: MeasureStatus
    readonly renderKind: HeatmapRenderKind
    readonly pendingJobId: string | null
    readonly displayLabel: string
    readonly modelDisclosure: ModelInferredDisclosureHeader | null
    readonly untrustedEmbeddedTexts: readonly UntrustedValue[]
    readonly deletionEpoch: number
    readonly buildSeq: number
    readonly reason: string
  }): RenderedHeatmapUnitArtifact {
    const envelope = this.buildUnitEnvelope({
      req: params.req,
      audience: params.audience,
      suppressedCellCount: 0,
      urlKey: params.urlKey,
      dataset: params.dataset,
      status: params.status,
      renderKind: params.renderKind,
      sections: [],
      clicks: [],
      reproHash: params.reproHash,
      limitations: [params.reason],
    })
    return Object.freeze({
      artifact_id: `hm_none_${params.reproHash.slice(0, 12)}`,
      unit_key: params.unitKeyStr,
      status: params.status,
      render_kind: params.renderKind,
      pending_job_id: params.pendingJobId,
      display_label: params.displayLabel,
      reproducibility_hash: params.reproHash,
      png_base64: null,
      png_sha256: null,
      svg_markup: null,
      width: 0,
      height: 0,
      screenshot_snapshot_id: null,
      screenshot_captured_at: null,
      redaction_count: 0,
      geometry_drift_G: params.dataset.measured_geometry_drift_G,
      verdict_version: params.req.verdict_version,
      actor_bucket: params.req.actor_bucket,
      model_inferred_disclosure: params.modelDisclosure,
      sections: Object.freeze([]),
      clicks: Object.freeze([]),
      untrusted_embedded_texts: Object.freeze(
        params.status === 'suppressed' ? [] : params.untrustedEmbeddedTexts,
      ),
      cache_hit: false,
      deletion_epoch: params.deletionEpoch,
      build_seq: params.buildSeq,
      envelope,
    })
  }

  private buildUnitEnvelope(params: {
    readonly req: HeatmapRenderRequest
    readonly audience: 'site_owner' | 'external_party'
    readonly suppressedCellCount: number
    readonly urlKey: string
    readonly dataset: HeatmapUnitDataset
    readonly status: MeasureStatus
    readonly renderKind: HeatmapRenderKind
    readonly sections: readonly HeatmapSectionMetricInput[]
    readonly clicks: readonly HeatmapClickPointInput[]
    readonly reproHash: string
    readonly limitations: readonly string[]
  }): SerializedResponseEnvelope {
    const isOk = params.status === 'ok'
    const evidenceLevel: EvidenceLevel =
      params.sections.some((s) => s.evidence === 'inferred') ||
      params.req.actor_bucket === 'model_inferred'
        ? 'inferred'
        : 'observed'
    const refId = `hmref_${params.reproHash.slice(0, 12)}`
    const measureKey = `heatmap_${params.req.kind}`

    // Never leak raw <10 denominators when status !== 'ok'; and for external_party with cell suppression,
    // coarsen disclosed total to a multiple of k=10 so residual subtraction cannot narrow suppressed cells!
    const safeDisclosedUnits = !isOk
      ? 0
      : params.audience === 'external_party' && params.suppressedCellCount > 0
        ? Math.floor(params.dataset.total_units_in_segment / EXTERNAL_PARTY_MIN_CELL_K) *
          EXTERNAL_PARTY_MIN_CELL_K
        : params.dataset.total_units_in_segment

    const rawGateReason = params.limitations[0] ?? params.status
    const gateReason =
      params.audience === 'external_party' && !isOk
        ? sanitizeExternalRejectionReason(rawGateReason)
        : rawGateReason
    const unmetGate: UnmetGate = {
      id: gateReason,
      required: EXTERNAL_PARTY_MIN_CELL_K,
      observed: 0,
      reason: gateReason,
      unlock:
        params.audience === 'external_party' && !isOk
          ? 'satisfy_disclosure_policy'
          : `satisfy_${params.status}_gate`,
    }

    const measure: MeasureInput<VerifiedNumericLeaf> = {
      value: isOk
        ? createDataLayerMetric(safeDisclosedUnits, refId, {
            authority: 'data_layer',
            createdAt: params.req.requested_at,
          })
        : null,
      unit: 'pv',
      status: params.status,
      ...(isOk
        ? {}
        : {
            reason: gateReason,
            unmet_gates: [unmetGate],
          }),
      evidence: {
        level: evidenceLevel,
        exactness: 'exact_as_of_build',
        criteria: [],
        refs: [
          {
            ref_id: refId,
            kind: 'snapshot',
            params_hash: params.reproHash,
            watermarks: { settled_agg: params.dataset.repro_inputs.settled_agg_version },
            result_digest: params.reproHash,
            issued_at: params.req.requested_at,
            valid_until: new Date(Date.parse(params.req.requested_at) + 86400_000).toISOString(),
            kid: 'hm_key_1',
          },
        ],
        scope: `${params.urlKey}|${params.renderKind}|${params.req.actor_bucket}`,
      },
      sample: isOk ? { n: safeDisclosedUnits, unit_kind: 'pv' } : null,
      interval: null,
    }

    return buildResponseEnvelope({
      window: {
        start: params.req.period_start,
        end: params.req.period_end,
        timezone: 'UTC',
      },
      freshness: {
        data_through: params.req.requested_at,
        lag_s: 0,
        sources: { heatmap_renderer: params.dataset.repro_inputs.renderer_version },
        stale: false,
      },
      coverage: {
        ratio: isOk ? 1 : 0,
        denominator_n: safeDisclosedUnits,
      },
      lineage: {
        schema_version: '2.0',
        def_ver: 1,
        collection_gen: 'v3',
      },
      residency: this.defaultResidency,
      measures: {
        [measureKey]: measure,
      },
      data: {
        url_key_v2: params.urlKey,
        render_kind: params.renderKind,
        actor_bucket: params.req.actor_bucket,
        verdict_version: params.req.verdict_version,
      },
    })
  }

  private errorResponse(
    httpStatus: 400 | 401 | 403 | 404 | 429,
    error: string,
    req: HeatmapRenderRequest,
    urlKey: string,
    lane: HeatmapDataLane,
  ): HeatmapRenderResponse {
    return Object.freeze({
      http_status: httpStatus,
      ok: false,
      error,
      tenant_id: req.tenant_id,
      site_id: req.site_id,
      page_url_key: urlKey,
      kind: req.kind,
      lane,
      split_unit_count: 0,
      artifacts: Object.freeze([]),
      limitations: Object.freeze([]),
      residency: this.defaultResidency,
      untrusted_boundary_enforced: true,
    })
  }
}

// ---------------------------------------------------------------------------
// 5. MCP Tool Definition & Invocation Adapter (§11.12 / §11.7)
// ---------------------------------------------------------------------------

export const HEATMAP_IMAGE_MCP_TOOL = Object.freeze({
  name: 'ugokilink_renderHeatmapImage',
  operationId: 'renderHeatmapImage',
  description:
    '[R0] Render a deterministic heatmap image (PNG + structured raw section/element metrics + unit version + evidence envelope) for a site page URL, split by page version/variant and actor class.',
  riskClass: 'R0' as const,
  individualHighRiskTool: false,
  requiredScope: 'analytics:read',
  costUnits: 5,
  eagerPriority: 10,
  inputSchema: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      siteId: { type: 'string' },
      page_url: { type: 'string' },
      period_start: { type: 'string' },
      period_end: { type: 'string' },
      device_class: { type: 'string', enum: ['desktop', 'mobile', 'tablet'] },
      kind: { type: 'string', enum: ['click', 'scroll_reach', 'section_dwell'] },
      actor_bucket: {
        type: 'string',
        enum: [
          'verified_actor',
          'explicit_evidence',
          'model_inferred',
          'undecided_unscorable',
          'lab_run',
          'http_crawler',
        ],
      },
      segment_id: { type: 'string' },
      include_image_content: { type: 'boolean' },
    }),
    required: Object.freeze([
      'siteId',
      'page_url',
      'period_start',
      'period_end',
      'device_class',
      'kind',
      'actor_bucket',
      'segment_id',
    ]),
    additionalProperties: false,
  }),
})

export type McpHeatmapContentBlock =
  | { readonly type: 'image'; readonly mimeType: 'image/png'; readonly data: string }
  | { readonly type: 'text'; readonly text: string }

/**
 * MCP 呼び出しハンドラ: 画像対応クライアントには base64 PNG 画像ブロック＋構造化返答を同時返却する (§11.12)。
 */
export function invokeHeatmapImageMcpTool(params: {
  readonly service: HeatmapRenderService
  readonly principal: HeatmapFetchPrincipal | null
  readonly request: HeatmapRenderRequest
  readonly client_supports_images?: boolean
}): {
  readonly isError: boolean
  readonly http_status: HeatmapRenderResponse['http_status']
  readonly content: readonly McpHeatmapContentBlock[]
  readonly structured: HeatmapRenderResponse
} {
  const response = params.service.renderHeatmap(params.principal, params.request)
  const content: McpHeatmapContentBlock[] = []

  if (params.client_supports_images !== false) {
    for (const art of response.artifacts) {
      if (art.png_base64) {
        content.push(
          Object.freeze({
            type: 'image',
            mimeType: 'image/png',
            data: art.png_base64,
          }),
        )
      }
    }
  }

  content.push(
    Object.freeze({
      type: 'text',
      text: JSON.stringify({
        ok: response.ok,
        http_status: response.http_status,
        page_url_key: response.page_url_key,
        kind: response.kind,
        split_unit_count: response.split_unit_count,
        limitations: response.limitations,
        artifacts: response.artifacts.map((a) => ({
          artifact_id: a.artifact_id,
          unit_key: a.unit_key,
          status: a.status,
          render_kind: a.render_kind,
          pending_job_id: a.pending_job_id,
          display_label: a.display_label,
          png_sha256: a.png_sha256,
          geometry_drift_G: a.geometry_drift_G,
          verdict_version: a.verdict_version,
          actor_bucket: a.actor_bucket,
          untrusted_embedded_texts: a.untrusted_embedded_texts,
        })),
      }),
    }),
  )

  return Object.freeze({
    isError: !response.ok,
    http_status: response.http_status,
    content: Object.freeze(content),
    structured: response,
  })
}
