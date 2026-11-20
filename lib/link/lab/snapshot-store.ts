/**
 * UGOKI LINK v2 — 束 2-C (手順 5): 変更前スナップショット＆不変契約管理
 *
 * - 構造の版 `(page_id, variant_set_key, skel_fp)` の確定管理
 *   (実訪問は `candidate` のみ作成し、検査環境・オーナー・CMS 記録でのみ `confirmed` へ昇格)
 * - 2 回連続非再現での描画停止規則 (`lab_unreproducible`, §6.2 / `join.G15`)
 * - 変更時刻の幅 `[last_seen_old, first_seen_new]` の管理・精密化 (介入台帳 → CMS → 条件取得 → 前後描画)
 * - 区画系譜 (`section_uid` の不変追跡・文 3-gram 重なり＆包含による改名/分割/統合照合)
 * - 不変スナップショット契約 (§11.3: UTC 必須、未計測は必ず `null`、ハッシュ改ざん検知)
 *
 * 設計根拠:
 * - マスター設計書 v2 §6.2, §6.3, §6.7, §11.3, §13.1
 * - join-final.md M3, A5, R-12, R-13
 */

import { createHash } from 'node:crypto'

import { normText, type SegmenterOutput } from '@/packages/contract/segmenter'

import type {
  LabDeviceProfile,
  RenderJobClass,
  RenderPageResult,
  RenderedElementDetails,
  RenderedSectionGeometry,
  ScreenshotMeta,
} from './secondary-renderer'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StructureVersionState =
  | 'candidate'
  | 'lab_confirmed'
  | 'owner_confirmed'
  | 'lab_unreproducible'

export type ChangeTimeSource =
  | 'intervention_ledger'
  | 'cms_publish_hook'
  | 'page_declared_modified'
  | 'conditional_get'
  | 'bracketing_lab_render'
  | 'field_sighting'

export const CHANGE_TIME_SOURCE_PRIORITY: Readonly<Record<ChangeTimeSource, number>> = Object.freeze({
  intervention_ledger: 1,
  cms_publish_hook: 2,
  page_declared_modified: 3,
  conditional_get: 4,
  bracketing_lab_render: 5,
  field_sighting: 6,
})

export interface SnapshotIdentityKey {
  readonly link_grant_id: string
  readonly producer: 'ugoki_second_executor' | 'linkth_crawl'
  readonly source_job_id: string
  readonly analysis_gen: number
  readonly export_gen: number
  readonly dataset_kind: 'structure_snapshot_v2' | 'structure_identity_v1'
  readonly contract_ver: string
}

export interface ImmutableStructureSnapshot {
  readonly snapshot_id: string
  readonly content_hash: string
  readonly tenant_id: string
  readonly site_id: string
  readonly page_id: string
  readonly url_id: string
  readonly url_key_v2: string
  readonly variant_set_key: string
  readonly identity_key: SnapshotIdentityKey
  /** UTC ISO-8601 */
  readonly rendered_at: string
  /** UTC ISO-8601 */
  readonly recorded_at: string
  readonly is_pre_change_baseline: boolean
  readonly baseline_reason: string | null
  readonly job_class: RenderJobClass
  readonly profile: LabDeviceProfile
  readonly segmenter_hash: string
  readonly skel_fp: string | null
  readonly struct_fp: string | null
  readonly head_fp: string | null
  readonly css_fp: string | null
  readonly res_fp: string | null
  readonly slot_fp: string | null
  readonly segmenter_output: SegmenterOutput | null
  /** Unmeasured metrics MUST remain null, NEVER 0 (§11.3 / R-12) */
  readonly doc_h_px: number | null
  readonly section_geometries: readonly RenderedSectionGeometry[] | null
  readonly element_details: readonly RenderedElementDetails[]
  readonly screenshot: ScreenshotMeta | null
  readonly volatile_sections: readonly string[]
  readonly css_volatile: boolean
}

export interface StructureVersionRecord {
  readonly tenant_id: string
  readonly site_id: string
  readonly page_id: string
  readonly variant_set_key: string
  readonly skel_fp: string
  readonly state: StructureVersionState
  readonly first_seen_at: string
  readonly last_seen_at: string
  readonly confirmed_at: string | null
  readonly confirmed_by: 'lab' | 'owner' | 'cms' | null
  readonly confirmed_snapshot_id: string | null
  readonly non_reproducing_render_count: number
  readonly rendering_halted: boolean
  readonly volatile_sections: readonly string[]
}

export interface ChangeIntervalRecord {
  readonly interval_id: string
  readonly tenant_id: string
  readonly site_id: string
  readonly page_id: string
  readonly variant_set_key: string
  readonly old_skel_fp: string
  readonly new_skel_fp: string
  /** Last sighting of old version (UTC ISO-8601) */
  readonly t_lo: string
  /** First sighting of new version (UTC ISO-8601) */
  readonly t_hi: string
  /** t_hi - t_lo in ms (0 when exact or collapsed; negative crossings flagged via mixed_window) */
  readonly width_ms: number
  /** True when old and new sightings overlapped in time -> excluded from before/after comparisons (§6.3) */
  readonly mixed_window: boolean
  readonly source: ChangeTimeSource
  readonly ledger_id: string | null
}

export interface SectionLineageInput {
  readonly sec_fp: string
  readonly body_fp: string
  readonly ordinal: number
  readonly heading_text: string
  readonly body_text: string
  readonly section_uid?: string
  readonly pinned?: boolean
}

export type SectionChangeEventKind =
  | 'unchanged'
  | 'text_edited'
  | 'moved'
  | 'heading_renamed'
  | 'split'
  | 'merged'
  | 'added'
  | 'removed'

export interface SectionLineageMatch {
  readonly section_uid: string
  readonly new_sec_fp: string | null
  readonly old_sec_fp: string | null
  readonly evidence_level: 'observed' | 'inferred'
  readonly match_method: 'exact_sec_fp' | 'pin_or_ledger' | 'text_overlap' | 'containment' | 'new_allocation' | 'removed'
  readonly change_event: SectionChangeEventKind
  readonly score: number | null
}

export interface SectionLineageResult {
  readonly page_id: string
  readonly matches: readonly SectionLineageMatch[]
  readonly events: readonly {
    readonly kind: Exclude<SectionChangeEventKind, 'unchanged'>
    readonly section_uid: string
    readonly old_sec_fp: string | null
    readonly new_sec_fp: string | null
  }[]
}

export class ImmutableSnapshotError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImmutableSnapshotError'
  }
}

// ---------------------------------------------------------------------------
// Deterministic Snapshot ID & UTC Validation Helpers
// ---------------------------------------------------------------------------

function assertUtcIso(value: string, fieldName: string): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) {
    throw new ImmutableSnapshotError(`${fieldName} must be a strict UTC ISO-8601 timestamp ending in "Z" (got "${value}")`)
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new ImmutableSnapshotError(`${fieldName} is not a valid date: "${value}"`)
  }
}

export function computeSnapshotId(key: SnapshotIdentityKey): string {
  const canonical = [
    key.link_grant_id,
    key.producer,
    key.source_job_id,
    String(key.analysis_gen),
    String(key.export_gen),
    key.dataset_kind,
    key.contract_ver,
  ].join('|')
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 24)
  return `snap_${key.dataset_kind}_${digest}`
}

export function computeSnapshotContentHash(snapshotBody: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(snapshotBody), 'utf8').digest('hex')
}

export function createSnapshotFromRender(params: {
  readonly render: RenderPageResult
  readonly page_id: string
  readonly identity_key: SnapshotIdentityKey
  readonly recorded_at: string
  readonly is_pre_change_baseline?: boolean
  readonly baseline_reason?: string | null
  readonly volatile_sections?: readonly string[]
  readonly css_volatile?: boolean
}): ImmutableStructureSnapshot {
  const { render, identity_key } = params
  assertUtcIso(render.rendered_at, 'rendered_at')
  assertUtcIso(params.recorded_at, 'recorded_at')

  const seg = render.segmenter_output
  const snapshotId = computeSnapshotId(identity_key)

  const corePayload = {
    snapshot_id: snapshotId,
    tenant_id: render.tenant_id,
    site_id: render.site_id,
    page_id: params.page_id,
    url_id: render.url_key_result.url_id,
    url_key_v2: render.url_key_result.url_key_v2,
    variant_set_key: render.variant_set_key,
    identity_key,
    rendered_at: render.rendered_at,
    job_class: render.job_class,
    profile_id: render.profile.profile_id,
    segmenter_hash: render.segmenter_hash,
    skel_fp: seg?.skel_fp ?? null,
    struct_fp: seg?.struct_fp ?? null,
    head_fp: seg?.head_fp ?? null,
    css_fp: seg?.css_fp ?? null,
    res_fp: seg?.res_fp ?? null,
    slot_fp: seg?.slot_fp ?? null,
    doc_h_px: render.doc_h_px,
    section_geometries: render.section_geometries,
    screenshot_storage_key: render.screenshot?.storage_key ?? null,
  }

  const contentHash = computeSnapshotContentHash(corePayload)

  return Object.freeze({
    snapshot_id: snapshotId,
    content_hash: contentHash,
    tenant_id: render.tenant_id,
    site_id: render.site_id,
    page_id: params.page_id,
    url_id: render.url_key_result.url_id,
    url_key_v2: render.url_key_result.url_key_v2,
    variant_set_key: render.variant_set_key,
    identity_key: Object.freeze({ ...identity_key }),
    rendered_at: render.rendered_at,
    recorded_at: params.recorded_at,
    is_pre_change_baseline: params.is_pre_change_baseline ?? false,
    baseline_reason: params.baseline_reason ?? null,
    job_class: render.job_class,
    profile: render.profile,
    segmenter_hash: render.segmenter_hash,
    skel_fp: seg?.skel_fp ?? null,
    struct_fp: seg?.struct_fp ?? null,
    head_fp: seg?.head_fp ?? null,
    css_fp: seg?.css_fp ?? null,
    res_fp: seg?.res_fp ?? null,
    slot_fp: seg?.slot_fp ?? null,
    segmenter_output: seg,
    doc_h_px: render.doc_h_px,
    section_geometries: render.section_geometries,
    element_details: render.element_details,
    screenshot: render.screenshot,
    volatile_sections: Object.freeze([...(params.volatile_sections ?? [])]),
    css_volatile: params.css_volatile ?? false,
  })
}

// ---------------------------------------------------------------------------
// Section Lineage Engine (join-final.md M3 & Appendix A5)
// ---------------------------------------------------------------------------

function charShingles(text: string, k = 3): Set<string> {
  const norm = normText(text)
  const set = new Set<string>()
  if (norm.length === 0) return set
  if (norm.length < k) {
    set.add(norm)
    return set
  }
  for (let i = 0; i <= norm.length - k; i++) {
    set.add(norm.slice(i, i + k))
  }
  return set
}

function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const item of a) {
    if (b.has(item)) inter++
  }
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

function diceSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const item of a) {
    if (b.has(item)) inter++
  }
  return (2 * inter) / (a.size + b.size)
}

function containmentRatio(smaller: ReadonlySet<string>, larger: ReadonlySet<string>): number {
  if (smaller.size === 0) return 0
  let inter = 0
  for (const item of smaller) {
    if (larger.has(item)) inter++
  }
  return inter / smaller.size
}

export function allocateSectionUid(pageId: string, secFp: string, epochOrdinal = 0): string {
  const digest = createHash('sha256')
    .update(`section_uid/1|${pageId}|${secFp}|${epochOrdinal}`, 'utf8')
    .digest('hex')
    .slice(0, 16)
  return `suid_${digest}`
}

/**
 * 変更前後の区画リストから永続 ID (`section_uid`) を追跡する (設計書 §6.3 / join-final.md M3)。
 * - `sec_fp` 一致または介入台帳/ピン固定 → `observed`
 * - `sec_fp` 変化時は `0.65·Jaccard(body) + 0.25·Dice(heading) + 0.10·(1 - |Δrank|)` ≥ 0.60
 *   かつ 2 位との差 ≥ 0.10 で引き継ぎ (`inferred`)。包含率 ≥ 0.80 は `split` / `merged` 判定。
 */
export function resolveSectionLineage(params: {
  readonly page_id: string
  readonly old_sections: readonly SectionLineageInput[]
  readonly new_sections: readonly SectionLineageInput[]
  /** Optional explicit old_sec_fp -> new_sec_fp mappings from intervention ledger */
  readonly ledger_ground_truth?: Readonly<Record<string, string>>
}): SectionLineageResult {
  const { page_id, old_sections, new_sections, ledger_ground_truth } = params
  const maxLen = Math.max(old_sections.length, new_sections.length, 1)

  const oldWithUid = old_sections.map((s, idx) => ({
    ...s,
    uid: s.section_uid ?? allocateSectionUid(page_id, s.sec_fp, idx),
    bodyShingles: charShingles(s.body_text, 3),
    headingShingles: charShingles(s.heading_text, 2),
  }))

  const newPrepared = new_sections.map((s) => ({
    ...s,
    bodyShingles: charShingles(s.body_text, 3),
    headingShingles: charShingles(s.heading_text, 2),
  }))

  const matchedOld = new Set<number>()
  const matchedNew = new Set<number>()
  const matches: SectionLineageMatch[] = []
  const events: Array<{
    readonly kind: Exclude<SectionChangeEventKind, 'unchanged'>
    readonly section_uid: string
    readonly old_sec_fp: string | null
    readonly new_sec_fp: string | null
  }> = []

  // Pass 1: Ledger ground truth mappings (`observed`)
  if (ledger_ground_truth) {
    for (let oi = 0; oi < oldWithUid.length; oi++) {
      const targetNewFp = ledger_ground_truth[oldWithUid[oi].sec_fp]
      if (!targetNewFp) continue
      const ni = newPrepared.findIndex((ns, idx) => !matchedNew.has(idx) && ns.sec_fp === targetNewFp)
      if (ni >= 0) {
        matchedOld.add(oi)
        matchedNew.add(ni)
        const oldSec = oldWithUid[oi]
        const newSec = newPrepared[ni]
        const kind: SectionChangeEventKind =
          oldSec.sec_fp !== newSec.sec_fp
            ? 'heading_renamed'
            : oldSec.body_fp !== newSec.body_fp
              ? 'text_edited'
              : oldSec.ordinal !== newSec.ordinal
                ? 'moved'
                : 'unchanged'
        matches.push(
          Object.freeze({
            section_uid: oldSec.uid,
            old_sec_fp: oldSec.sec_fp,
            new_sec_fp: newSec.sec_fp,
            evidence_level: 'observed',
            match_method: 'pin_or_ledger',
            change_event: kind,
            score: 1,
          }),
        )
        if (kind !== 'unchanged') {
          events.push(Object.freeze({ kind, section_uid: oldSec.uid, old_sec_fp: oldSec.sec_fp, new_sec_fp: newSec.sec_fp }))
        }
      }
    }
  }

  // Pass 2: Exact `sec_fp` equality (`observed`)
  for (let oi = 0; oi < oldWithUid.length; oi++) {
    if (matchedOld.has(oi)) continue
    const oldSec = oldWithUid[oi]
    const ni = newPrepared.findIndex((ns, idx) => !matchedNew.has(idx) && ns.sec_fp === oldSec.sec_fp)
    if (ni >= 0) {
      matchedOld.add(oi)
      matchedNew.add(ni)
      const newSec = newPrepared[ni]
      const kind: SectionChangeEventKind =
        oldSec.body_fp !== newSec.body_fp
          ? 'text_edited'
          : oldSec.ordinal !== newSec.ordinal
            ? 'moved'
            : 'unchanged'
      matches.push(
        Object.freeze({
          section_uid: oldSec.uid,
          old_sec_fp: oldSec.sec_fp,
          new_sec_fp: newSec.sec_fp,
          evidence_level: 'observed',
          match_method: 'exact_sec_fp',
          change_event: kind,
          score: 1,
        }),
      )
      if (kind !== 'unchanged') {
        events.push(Object.freeze({ kind, section_uid: oldSec.uid, old_sec_fp: oldSec.sec_fp, new_sec_fp: newSec.sec_fp }))
      }
    }
  }

  // Pass 3: Text overlap & containment matching for unmatched sections (`inferred`)
  for (let ni = 0; ni < newPrepared.length; ni++) {
    if (matchedNew.has(ni)) continue
    const newSec = newPrepared[ni]

    const scored: Array<{
      readonly oi: number
      readonly score: number
      readonly newInOld: number
      readonly oldInNew: number
    }> = []

    for (let oi = 0; oi < oldWithUid.length; oi++) {
      if (matchedOld.has(oi)) continue
      const oldSec = oldWithUid[oi]
      const j = jaccardSimilarity(oldSec.bodyShingles, newSec.bodyShingles)
      const dice = diceSimilarity(oldSec.headingShingles, newSec.headingShingles)
      const rankTerm = 1 - Math.abs(oldSec.ordinal - newSec.ordinal) / maxLen
      const score = 0.65 * j + 0.25 * dice + 0.1 * rankTerm
      const newInOld = containmentRatio(newSec.bodyShingles, oldSec.bodyShingles)
      const oldInNew = containmentRatio(oldSec.bodyShingles, newSec.bodyShingles)
      scored.push({ oi, score, newInOld, oldInNew })
    }

    scored.sort((a, b) => b.score - a.score)
    const best = scored[0]
    const second = scored[1]

    if (best && best.score >= 0.6 && (!second || best.score - second.score >= 0.1)) {
      const oldSec = oldWithUid[best.oi]
      matchedOld.add(best.oi)
      matchedNew.add(ni)
      matches.push(
        Object.freeze({
          section_uid: oldSec.uid,
          old_sec_fp: oldSec.sec_fp,
          new_sec_fp: newSec.sec_fp,
          evidence_level: 'inferred',
          match_method: 'text_overlap',
          change_event: 'heading_renamed',
          score: Number(best.score.toFixed(4)),
        }),
      )
      events.push(
        Object.freeze({
          kind: 'heading_renamed',
          section_uid: oldSec.uid,
          old_sec_fp: oldSec.sec_fp,
          new_sec_fp: newSec.sec_fp,
        }),
      )
      continue
    }

    // Split / Merge detection via containment >= 0.80 (join-final.md M3)
    const splitCandidate = scored.find((s) => s.newInOld >= 0.8)
    if (splitCandidate) {
      const oldSec = oldWithUid[splitCandidate.oi]
      matchedNew.add(ni)
      matches.push(
        Object.freeze({
          section_uid: oldSec.uid,
          old_sec_fp: oldSec.sec_fp,
          new_sec_fp: newSec.sec_fp,
          evidence_level: 'inferred',
          match_method: 'containment',
          change_event: 'split',
          score: Number(splitCandidate.newInOld.toFixed(4)),
        }),
      )
      events.push(
        Object.freeze({
          kind: 'split',
          section_uid: oldSec.uid,
          old_sec_fp: oldSec.sec_fp,
          new_sec_fp: newSec.sec_fp,
        }),
      )
      continue
    }

    const mergeCandidate = scored.find((s) => s.oldInNew >= 0.8)
    if (mergeCandidate) {
      const oldSec = oldWithUid[mergeCandidate.oi]
      matchedOld.add(mergeCandidate.oi)
      matchedNew.add(ni)
      matches.push(
        Object.freeze({
          section_uid: oldSec.uid,
          old_sec_fp: oldSec.sec_fp,
          new_sec_fp: newSec.sec_fp,
          evidence_level: 'inferred',
          match_method: 'containment',
          change_event: 'merged',
          score: Number(mergeCandidate.oldInNew.toFixed(4)),
        }),
      )
      events.push(
        Object.freeze({
          kind: 'merged',
          section_uid: oldSec.uid,
          old_sec_fp: oldSec.sec_fp,
          new_sec_fp: newSec.sec_fp,
        }),
      )
      continue
    }

    // Newly added section
    const newUid = allocateSectionUid(page_id, newSec.sec_fp, newSec.ordinal)
    matchedNew.add(ni)
    matches.push(
      Object.freeze({
        section_uid: newUid,
        old_sec_fp: null,
        new_sec_fp: newSec.sec_fp,
        evidence_level: 'observed',
        match_method: 'new_allocation',
        change_event: 'added',
        score: null,
      }),
    )
    events.push(
      Object.freeze({
        kind: 'added',
        section_uid: newUid,
        old_sec_fp: null,
        new_sec_fp: newSec.sec_fp,
      }),
    )
  }

  // Pass 4: Remaining unmatched old sections -> removed
  for (let oi = 0; oi < oldWithUid.length; oi++) {
    if (matchedOld.has(oi)) continue
    const oldSec = oldWithUid[oi]
    matches.push(
      Object.freeze({
        section_uid: oldSec.uid,
        old_sec_fp: oldSec.sec_fp,
        new_sec_fp: null,
        evidence_level: 'observed',
        match_method: 'removed',
        change_event: 'removed',
        score: null,
      }),
    )
    events.push(
      Object.freeze({
        kind: 'removed',
        section_uid: oldSec.uid,
        old_sec_fp: oldSec.sec_fp,
        new_sec_fp: null,
      }),
    )
  }

  return Object.freeze({
    page_id,
    matches: Object.freeze(matches),
    events: Object.freeze(events),
  })
}

// ---------------------------------------------------------------------------
// Tenant-Scoped Immutable Snapshot & Version Store
// ---------------------------------------------------------------------------

export class LabSnapshotStore {
  private readonly snapshots = new Map<string, ImmutableStructureSnapshot>()
  private readonly versions = new Map<string, StructureVersionRecord>()
  private readonly changeIntervals = new Map<string, ChangeIntervalRecord>()

  private versionKey(
    tenantId: string,
    siteId: string,
    pageId: string,
    variantSetKey: string,
    skelFp: string,
  ): string {
    return `${tenantId}|${siteId}|${pageId}|${variantSetKey}|${skelFp}`
  }

  private assertTenant(tenantId: string, siteId: string): void {
    if (!tenantId.trim() || !siteId.trim()) {
      throw new ImmutableSnapshotError('tenant_id and site_id are mandatory')
    }
  }

  /**
   * 不変スナップショットを保存する。同一 `snapshot_id` への異なる内容の上書きは禁止。
   */
  saveSnapshot(snapshot: ImmutableStructureSnapshot): void {
    this.assertTenant(snapshot.tenant_id, snapshot.site_id)
    assertUtcIso(snapshot.rendered_at, 'rendered_at')
    assertUtcIso(snapshot.recorded_at, 'recorded_at')

    const existing = this.snapshots.get(snapshot.snapshot_id)
    if (existing) {
      if (
        existing.content_hash === snapshot.content_hash &&
        existing.tenant_id === snapshot.tenant_id &&
        existing.site_id === snapshot.site_id
      ) {
        return
      }
      throw new ImmutableSnapshotError(
        `Snapshot "${snapshot.snapshot_id}" already exists and cannot be mutated`,
      )
    }
    this.snapshots.set(snapshot.snapshot_id, Object.freeze(snapshot))
  }

  getSnapshot(
    tenantId: string,
    siteId: string,
    snapshotId: string,
  ): ImmutableStructureSnapshot | null {
    this.assertTenant(tenantId, siteId)
    const snap = this.snapshots.get(snapshotId)
    if (!snap || snap.tenant_id !== tenantId || snap.site_id !== siteId) {
      return null
    }
    return snap
  }

  listSnapshotsForPage(
    tenantId: string,
    siteId: string,
    pageId: string,
  ): readonly ImmutableStructureSnapshot[] {
    this.assertTenant(tenantId, siteId)
    const list: ImmutableStructureSnapshot[] = []
    for (const snap of this.snapshots.values()) {
      if (snap.tenant_id === tenantId && snap.site_id === siteId && snap.page_id === pageId) {
        list.push(snap)
      }
    }
    list.sort((a, b) => Date.parse(a.rendered_at) - Date.parse(b.rendered_at))
    return Object.freeze(list)
  }

  getLatestPreChangeBaseline(
    tenantId: string,
    siteId: string,
    pageId: string,
    variantSetKey = '0',
  ): ImmutableStructureSnapshot | null {
    const list = this.listSnapshotsForPage(tenantId, siteId, pageId).filter(
      (s) => s.is_pre_change_baseline && s.variant_set_key === variantSetKey,
    )
    return list.length > 0 ? list[list.length - 1] : null
  }

  /**
   * 統制規則 (§6.7): 実訪問は構造の版を `candidate` として提案するのみ。確定は決して行わない。
   */
  recordFieldCandidate(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly page_id: string
    readonly variant_set_key: string
    readonly skel_fp: string
    readonly observed_at: string
  }): StructureVersionRecord {
    this.assertTenant(params.tenant_id, params.site_id)
    assertUtcIso(params.observed_at, 'observed_at')

    const key = this.versionKey(
      params.tenant_id,
      params.site_id,
      params.page_id,
      params.variant_set_key,
      params.skel_fp,
    )
    const existing = this.versions.get(key)
    if (existing) {
      const updated: StructureVersionRecord = Object.freeze({
        ...existing,
        first_seen_at:
          Date.parse(params.observed_at) < Date.parse(existing.first_seen_at)
            ? params.observed_at
            : existing.first_seen_at,
        last_seen_at:
          Date.parse(params.observed_at) > Date.parse(existing.last_seen_at)
            ? params.observed_at
            : existing.last_seen_at,
      })
      this.versions.set(key, updated)
      return updated
    }

    const created: StructureVersionRecord = Object.freeze({
      tenant_id: params.tenant_id,
      site_id: params.site_id,
      page_id: params.page_id,
      variant_set_key: params.variant_set_key,
      skel_fp: params.skel_fp,
      state: 'candidate',
      first_seen_at: params.observed_at,
      last_seen_at: params.observed_at,
      confirmed_at: null,
      confirmed_by: null,
      confirmed_snapshot_id: null,
      non_reproducing_render_count: 0,
      rendering_halted: false,
      volatile_sections: Object.freeze([]),
    })
    this.versions.set(key, created)
    return created
  }

  /**
   * 検査環境による構造版の確定 (`candidate` -> `lab_confirmed`)。
   */
  confirmVersionByLab(snapshot: ImmutableStructureSnapshot): StructureVersionRecord {
    if (!snapshot.skel_fp) {
      throw new ImmutableSnapshotError('Cannot confirm structure version from snapshot with null skel_fp')
    }
    this.saveSnapshot(snapshot)

    const key = this.versionKey(
      snapshot.tenant_id,
      snapshot.site_id,
      snapshot.page_id,
      snapshot.variant_set_key,
      snapshot.skel_fp,
    )
    const existing = this.versions.get(key)
    const confirmed: StructureVersionRecord = Object.freeze({
      tenant_id: snapshot.tenant_id,
      site_id: snapshot.site_id,
      page_id: snapshot.page_id,
      variant_set_key: snapshot.variant_set_key,
      skel_fp: snapshot.skel_fp,
      state: 'lab_confirmed',
      first_seen_at: existing ? existing.first_seen_at : snapshot.rendered_at,
      last_seen_at: snapshot.rendered_at,
      confirmed_at: snapshot.rendered_at,
      confirmed_by: 'lab',
      confirmed_snapshot_id: snapshot.snapshot_id,
      non_reproducing_render_count: 0,
      rendering_halted: false,
      volatile_sections: snapshot.volatile_sections,
    })
    this.versions.set(key, confirmed)
    return confirmed
  }

  /**
   * オーナーまたは CMS 記録による構造版の確定 (`candidate` -> `owner_confirmed`)。
   */
  confirmVersionByOwnerOrCms(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly page_id: string
    readonly variant_set_key: string
    readonly skel_fp: string
    readonly confirmed_at: string
    readonly confirmed_by: 'owner' | 'cms'
  }): StructureVersionRecord {
    this.assertTenant(params.tenant_id, params.site_id)
    assertUtcIso(params.confirmed_at, 'confirmed_at')

    const key = this.versionKey(
      params.tenant_id,
      params.site_id,
      params.page_id,
      params.variant_set_key,
      params.skel_fp,
    )
    const existing = this.versions.get(key)
    const confirmed: StructureVersionRecord = Object.freeze({
      tenant_id: params.tenant_id,
      site_id: params.site_id,
      page_id: params.page_id,
      variant_set_key: params.variant_set_key,
      skel_fp: params.skel_fp,
      state: 'owner_confirmed',
      first_seen_at: existing ? existing.first_seen_at : params.confirmed_at,
      last_seen_at: params.confirmed_at,
      confirmed_at: params.confirmed_at,
      confirmed_by: params.confirmed_by,
      confirmed_snapshot_id: existing?.confirmed_snapshot_id ?? null,
      non_reproducing_render_count: 0,
      rendering_halted: false,
      volatile_sections: existing?.volatile_sections ?? Object.freeze([]),
    })
    this.versions.set(key, confirmed)
    return confirmed
  }

  /**
   * 停止規則 (§6.2 / `join.G15`): 検査環境で 2 回描画しても実訪問の `skel_fp` が再現しない場合、
   * `lab_unreproducible` として記録し、実訪問側が変わるまで再描画費用を止める。
   */
  recordNonReproducingRender(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly page_id: string
    readonly variant_set_key: string
    readonly skel_fp: string
    readonly attempted_at: string
  }): StructureVersionRecord {
    this.assertTenant(params.tenant_id, params.site_id)
    assertUtcIso(params.attempted_at, 'attempted_at')

    const key = this.versionKey(
      params.tenant_id,
      params.site_id,
      params.page_id,
      params.variant_set_key,
      params.skel_fp,
    )
    const base =
      this.versions.get(key) ??
      this.recordFieldCandidate({
        tenant_id: params.tenant_id,
        site_id: params.site_id,
        page_id: params.page_id,
        variant_set_key: params.variant_set_key,
        skel_fp: params.skel_fp,
        observed_at: params.attempted_at,
      })

    const count = base.non_reproducing_render_count + 1
    const halted = count >= 2
    const updated: StructureVersionRecord = Object.freeze({
      ...base,
      state: halted ? 'lab_unreproducible' : base.state,
      non_reproducing_render_count: count,
      rendering_halted: halted,
    })
    this.versions.set(key, updated)
    return updated
  }

  getVersion(
    tenantId: string,
    siteId: string,
    pageId: string,
    variantSetKey: string,
    skelFp: string,
  ): StructureVersionRecord | null {
    this.assertTenant(tenantId, siteId)
    return (
      this.versions.get(this.versionKey(tenantId, siteId, pageId, variantSetKey, skelFp)) ?? null
    )
  }

  shouldAllowRender(
    tenantId: string,
    siteId: string,
    pageId: string,
    variantSetKey: string,
    skelFp: string,
  ): boolean {
    const rec = this.getVersion(tenantId, siteId, pageId, variantSetKey, skelFp)
    return rec ? !rec.rendering_halted : true
  }

  /**
   * 変更時刻の幅 `[t_lo, t_hi]` を登録する (§6.3)。
   * `t_lo > t_hi` のように旧版と新版が交差している場合は `mixed_window = true` として比較から除外対象とする。
   */
  recordChangeInterval(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly page_id: string
    readonly variant_set_key: string
    readonly old_skel_fp: string
    readonly new_skel_fp: string
    readonly last_seen_old: string
    readonly first_seen_new: string
    readonly source: ChangeTimeSource
    readonly ledger_id?: string | null
  }): ChangeIntervalRecord {
    this.assertTenant(params.tenant_id, params.site_id)
    assertUtcIso(params.last_seen_old, 'last_seen_old')
    assertUtcIso(params.first_seen_new, 'first_seen_new')

    const loMs = Date.parse(params.last_seen_old)
    const hiMs = Date.parse(params.first_seen_new)
    const mixed = loMs > hiMs
    const tLo = mixed ? params.first_seen_new : params.last_seen_old
    const tHi = mixed ? params.last_seen_old : params.first_seen_new
    const widthMs = Math.abs(hiMs - loMs)

    const intervalId = `chg_${createHash('sha256')
      .update(
        `${params.tenant_id}|${params.site_id}|${params.page_id}|${params.variant_set_key}|${params.old_skel_fp}|${params.new_skel_fp}`,
        'utf8',
      )
      .digest('hex')
      .slice(0, 16)}`

    const record: ChangeIntervalRecord = Object.freeze({
      interval_id: intervalId,
      tenant_id: params.tenant_id,
      site_id: params.site_id,
      page_id: params.page_id,
      variant_set_key: params.variant_set_key,
      old_skel_fp: params.old_skel_fp,
      new_skel_fp: params.new_skel_fp,
      t_lo: tLo,
      t_hi: tHi,
      width_ms: widthMs,
      mixed_window: mixed,
      source: params.source,
      ledger_id: params.ledger_id ?? null,
    })
    this.changeIntervals.set(intervalId, record)
    return record
  }

  /**
   * より高精度な根拠（介入台帳 > CMS > ページ宣言 > 条件取得 > 前後描画 > 実訪問）で
   * 既存の `[t_lo, t_hi]` 幅を狭める (§6.3 / join-final.md A5)。幅を広げる更新は拒否する。
   */
  tightenChangeInterval(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly interval_id: string
    readonly t_lo: string
    readonly t_hi: string
    readonly source: ChangeTimeSource
    readonly ledger_id?: string | null
  }): ChangeIntervalRecord | null {
    this.assertTenant(params.tenant_id, params.site_id)
    assertUtcIso(params.t_lo, 't_lo')
    assertUtcIso(params.t_hi, 't_hi')

    const existing = this.changeIntervals.get(params.interval_id)
    if (!existing || existing.tenant_id !== params.tenant_id || existing.site_id !== params.site_id) {
      return null
    }

    const newLoMs = Date.parse(params.t_lo)
    const newHiMs = Date.parse(params.t_hi)
    if (newLoMs > newHiMs) {
      throw new ImmutableSnapshotError('Tightened interval must satisfy t_lo <= t_hi')
    }

    const curLoMs = Date.parse(existing.t_lo)
    const curHiMs = Date.parse(existing.t_hi)
    const tightenedLoMs = Math.max(curLoMs, newLoMs)
    const tightenedHiMs = Math.min(curHiMs, newHiMs)

    // Intersected interval valid only if tightenedLo <= tightenedHi (or higher-priority authoritative source)
    const isHigherPriority =
      CHANGE_TIME_SOURCE_PRIORITY[params.source] < CHANGE_TIME_SOURCE_PRIORITY[existing.source]

    let finalLoMs: number
    let finalHiMs: number
    if (tightenedLoMs <= tightenedHiMs) {
      finalLoMs = tightenedLoMs
      finalHiMs = tightenedHiMs
    } else if (isHigherPriority && newHiMs - newLoMs <= existing.width_ms) {
      finalLoMs = newLoMs
      finalHiMs = newHiMs
    } else {
      return existing
    }

    const finalWidth = finalHiMs - finalLoMs
    if (finalWidth > existing.width_ms) {
      return existing
    }

    const updated: ChangeIntervalRecord = Object.freeze({
      ...existing,
      t_lo: new Date(finalLoMs).toISOString(),
      t_hi: new Date(finalHiMs).toISOString(),
      width_ms: finalWidth,
      mixed_window: finalWidth === 0 ? false : existing.mixed_window,
      source: isHigherPriority ? params.source : existing.source,
      ledger_id: params.ledger_id ?? existing.ledger_id,
    })
    this.changeIntervals.set(existing.interval_id, updated)
    return updated
  }

  getChangeInterval(
    tenantId: string,
    siteId: string,
    intervalId: string,
  ): ChangeIntervalRecord | null {
    this.assertTenant(tenantId, siteId)
    const rec = this.changeIntervals.get(intervalId)
    if (!rec || rec.tenant_id !== tenantId || rec.site_id !== siteId) return null
    return rec
  }
}
