/**
 * UGOKI LINK v2 — 束 4-D (手順 13): 入力種類別照合キー等値結合エンジン
 *
 * 設計書 §6.1, §6.2, §6.3 / join-final.md M1, M2, M3:
 * - PV 側が運ぶ約 40B の入力種別照合キー束と、CRAWL / 第 2 描画環境の不変スナップショットを、
 *   事実の種類が宣言する照合キー集合の厳密等値でのみ結合する（時間窓の一致だけでは絶対に結ばない）。
 * - 匿名範囲外 (`dom_state === 'private_scope'`) は照合キーを出力せず `not_collected` とする。
 * - 検査環境で揺らぎ判定された区画 (`volatile_sections`) は `sec_fp` 同一性のみ引き継ぎ、
 *   本文・意味ラベル・監査結果は引き継がない (§6.3)。
 * - 検査環境の位置・画面写真・押しやすさ等の視覚事実 (`visual_layout`) が有効なのは
 *   `full_render` かつ `skel_fp`・`css_fp` 一致かつ位置ずれ `G <= 0.08` のときのみ (§6.2)。
 */

import type { DomState } from '@/packages/contract/segmenter'
import type { ImmutableStructureSnapshot } from '@/lib/link/lab'

// ---------------------------------------------------------------------------
// Types & Declarative Fact -> Fingerprint Requirements
// ---------------------------------------------------------------------------

export type FactInputClass =
  | 'section_identity'
  | 'section_text'
  | 'page_structure'
  | 'visual_layout'
  | 'element_identity'
  | 'head_metadata'
  | 'link_graph'
  | 'resources'
  | 'delivery_slot'

export type FingerprintKeyName =
  | 'sec_fp'
  | 'body_fp'
  | 'skel_fp'
  | 'css_fp'
  | 'el_fp'
  | 'head_fp'
  | 'links_fp'
  | 'res_fp'
  | 'slot_fp'

export const VISUAL_FACT_MAX_GEOMETRY_DRIFT_G = 0.08

const freezeKeys = (keys: readonly FingerprintKeyName[]): readonly FingerprintKeyName[] =>
  Object.freeze([...keys])

/**
 * 各事実種別が要求する厳密等値照合キーの宣言表 (§6.1, §6.3)。
 */
export const FACT_REQUIRED_FINGERPRINTS: Readonly<
  Record<FactInputClass, readonly FingerprintKeyName[]>
> = Object.freeze({
  section_identity: freezeKeys(['sec_fp']),
  section_text: freezeKeys(['sec_fp', 'body_fp']),
  page_structure: freezeKeys(['skel_fp']),
  visual_layout: freezeKeys(['skel_fp', 'css_fp']),
  element_identity: freezeKeys(['el_fp']),
  head_metadata: freezeKeys(['head_fp']),
  link_graph: freezeKeys(['links_fp']),
  resources: freezeKeys(['res_fp']),
  delivery_slot: freezeKeys(['slot_fp']),
})

export interface PvSectionFingerprint {
  readonly sec_fp: string
  readonly body_fp: string | null
  readonly body_digest_128?: string | null
}

/**
 * PV が運ぶ入力種類別照合キー束（約 40 バイト相当のハッシュ群）。
 */
export interface PvFingerprintBundle {
  readonly tenant_id: string
  readonly site_id: string
  readonly page_id: string
  readonly pv_id: string
  readonly variant_set_key: string
  readonly observed_at: string
  readonly dom_state: DomState
  readonly skel_fp: string | null
  readonly css_fp: string | null
  readonly head_fp: string | null
  readonly links_fp: string | null
  readonly res_fp: string | null
  readonly slot_fp: string | null
  readonly sections?: readonly PvSectionFingerprint[]
  readonly element_fps?: readonly string[]
}

export interface SnapshotMatchRequest {
  readonly pv: PvFingerprintBundle
  readonly snapshot: ImmutableStructureSnapshot
  readonly fact_class: FactInputClass
  /** Required when fact_class is `section_identity` or `section_text` */
  readonly target_sec_fp?: string
  /** Required when fact_class is `element_identity` */
  readonly target_el_fp?: string
  /** Required for `visual_layout` validation (must be <= 0.08 per §6.2) */
  readonly measured_geometry_drift_G?: number | null
}

export type ExactJoinFailureReason =
  | 'private_scope_not_collected'
  | 'tenant_or_site_mismatch'
  | 'page_or_variant_mismatch'
  | 'missing_required_fingerprint'
  | 'fingerprint_mismatch'
  | 'volatile_section_no_text_carryover'
  | 'visual_requires_full_render'
  | 'visual_geometry_drift_exceeded'
  | 'visual_geometry_drift_unmeasured'
  | 'no_matching_snapshot'

export interface ExactFingerprintJoinResult {
  readonly matched: boolean
  readonly status: 'ok' | 'not_collected' | 'unmatched'
  readonly fact_class: FactInputClass
  readonly snapshot_id: string | null
  readonly checked_keys: readonly FingerprintKeyName[]
  readonly matched_keys: readonly FingerprintKeyName[]
  readonly volatile_identity_only: boolean
  readonly reason: ExactJoinFailureReason | 'exact_fingerprint_match'
}

// ---------------------------------------------------------------------------
// Exact Fingerprint Equality Matcher (Never Time-Window Only!)
// ---------------------------------------------------------------------------

export function matchPvToSnapshot(req: SnapshotMatchRequest): ExactFingerprintJoinResult {
  const requiredKeys = FACT_REQUIRED_FINGERPRINTS[req.fact_class]

  // 1. Anonymous-scope rule (§6.1): private_scope NEVER joins, returns not_collected
  if (req.pv.dom_state === 'private_scope') {
    return Object.freeze({
      matched: false,
      status: 'not_collected',
      fact_class: req.fact_class,
      snapshot_id: null,
      checked_keys: requiredKeys,
      matched_keys: Object.freeze([]),
      volatile_identity_only: false,
      reason: 'private_scope_not_collected',
    })
  }

  // 2. Strict tenant & site isolation
  if (
    req.pv.tenant_id !== req.snapshot.tenant_id ||
    req.pv.site_id !== req.snapshot.site_id
  ) {
    return Object.freeze({
      matched: false,
      status: 'unmatched',
      fact_class: req.fact_class,
      snapshot_id: null,
      checked_keys: requiredKeys,
      matched_keys: Object.freeze([]),
      volatile_identity_only: false,
      reason: 'tenant_or_site_mismatch',
    })
  }

  // 3. Strict (page_id, variant_set_key) scope
  if (
    req.pv.page_id !== req.snapshot.page_id ||
    req.pv.variant_set_key !== req.snapshot.variant_set_key
  ) {
    return Object.freeze({
      matched: false,
      status: 'unmatched',
      fact_class: req.fact_class,
      snapshot_id: null,
      checked_keys: requiredKeys,
      matched_keys: Object.freeze([]),
      volatile_identity_only: false,
      reason: 'page_or_variant_mismatch',
    })
  }

  // 4. Visual layout facts require full render (`job_class === 'full'`) + valid G <= 0.08 (§6.2)
  if (req.fact_class === 'visual_layout') {
    if (req.snapshot.job_class !== 'full') {
      return Object.freeze({
        matched: false,
        status: 'unmatched',
        fact_class: req.fact_class,
        snapshot_id: null,
        checked_keys: requiredKeys,
        matched_keys: Object.freeze([]),
        volatile_identity_only: false,
        reason: 'visual_requires_full_render',
      })
    }
    if (
      req.measured_geometry_drift_G === null ||
      req.measured_geometry_drift_G === undefined ||
      Number.isNaN(req.measured_geometry_drift_G)
    ) {
      return Object.freeze({
        matched: false,
        status: 'unmatched',
        fact_class: req.fact_class,
        snapshot_id: null,
        checked_keys: requiredKeys,
        matched_keys: Object.freeze([]),
        volatile_identity_only: false,
        reason: 'visual_geometry_drift_unmeasured',
      })
    }
    if (req.measured_geometry_drift_G > VISUAL_FACT_MAX_GEOMETRY_DRIFT_G) {
      return Object.freeze({
        matched: false,
        status: 'unmatched',
        fact_class: req.fact_class,
        snapshot_id: null,
        checked_keys: requiredKeys,
        matched_keys: Object.freeze([]),
        volatile_identity_only: false,
        reason: 'visual_geometry_drift_exceeded',
      })
    }
  }

  const matchedKeys: FingerprintKeyName[] = []
  let volatileIdentityOnly = false

  for (const key of requiredKeys) {
    switch (key) {
      case 'skel_fp': {
        if (!req.pv.skel_fp || !req.snapshot.skel_fp) {
          return failMatch(req.fact_class, requiredKeys, matchedKeys, 'missing_required_fingerprint')
        }
        if (req.pv.skel_fp !== req.snapshot.skel_fp) {
          return failMatch(req.fact_class, requiredKeys, matchedKeys, 'fingerprint_mismatch')
        }
        matchedKeys.push('skel_fp')
        break
      }

      case 'css_fp': {
        if (!req.pv.css_fp || !req.snapshot.css_fp) {
          return failMatch(req.fact_class, requiredKeys, matchedKeys, 'missing_required_fingerprint')
        }
        // §6.2: visual_layout ALWAYS requires exact css_fp equality (even if volatile, visuals cannot claim match)
        if (req.pv.css_fp !== req.snapshot.css_fp) {
          return failMatch(req.fact_class, requiredKeys, matchedKeys, 'fingerprint_mismatch')
        }
        matchedKeys.push('css_fp')
        break
      }

      case 'head_fp': {
        if (!req.pv.head_fp || !req.snapshot.head_fp) {
          return failMatch(req.fact_class, requiredKeys, matchedKeys, 'missing_required_fingerprint')
        }
        if (req.pv.head_fp !== req.snapshot.head_fp) {
          return failMatch(req.fact_class, requiredKeys, matchedKeys, 'fingerprint_mismatch')
        }
        matchedKeys.push('head_fp')
        break
      }

      case 'links_fp': {
        const snapLinks = req.snapshot.segmenter_output?.links_fp?.combined ?? null
        if (!req.pv.links_fp || !snapLinks) {
          return failMatch(req.fact_class, requiredKeys, matchedKeys, 'missing_required_fingerprint')
        }
        if (req.pv.links_fp !== snapLinks) {
          return failMatch(req.fact_class, requiredKeys, matchedKeys, 'fingerprint_mismatch')
        }
        matchedKeys.push('links_fp')
        break
      }

      case 'res_fp': {
        if (!req.pv.res_fp || !req.snapshot.res_fp) {
          return failMatch(req.fact_class, requiredKeys, matchedKeys, 'missing_required_fingerprint')
        }
        if (req.pv.res_fp !== req.snapshot.res_fp) {
          return failMatch(req.fact_class, requiredKeys, matchedKeys, 'fingerprint_mismatch')
        }
        matchedKeys.push('res_fp')
        break
      }

      case 'slot_fp': {
        if (!req.pv.slot_fp || !req.snapshot.slot_fp) {
          return failMatch(req.fact_class, requiredKeys, matchedKeys, 'missing_required_fingerprint')
        }
        if (req.pv.slot_fp !== req.snapshot.slot_fp) {
          return failMatch(req.fact_class, requiredKeys, matchedKeys, 'fingerprint_mismatch')
        }
        matchedKeys.push('slot_fp')
        break
      }

      case 'sec_fp': {
        const secFp = req.target_sec_fp
        if (!secFp) {
          return failMatch(req.fact_class, requiredKeys, matchedKeys, 'missing_required_fingerprint')
        }
        const pvHas = req.pv.sections?.some((s) => s.sec_fp === secFp) ?? false
        const snapHas =
          req.snapshot.segmenter_output?.sections.some((s) => s.sec_fp === secFp) ?? false
        if (!pvHas || !snapHas) {
          return failMatch(req.fact_class, requiredKeys, matchedKeys, 'fingerprint_mismatch')
        }
        if (req.snapshot.volatile_sections.includes(secFp)) {
          volatileIdentityOnly = true
        }
        matchedKeys.push('sec_fp')
        break
      }

      case 'body_fp': {
        const secFp = req.target_sec_fp
        if (!secFp) {
          return failMatch(req.fact_class, requiredKeys, matchedKeys, 'missing_required_fingerprint')
        }
        // §6.3: Lab-volatile sections carry identity ONLY, NEVER text/semantic/audit carryover
        if (req.snapshot.volatile_sections.includes(secFp)) {
          return failMatch(
            req.fact_class,
            requiredKeys,
            matchedKeys,
            'volatile_section_no_text_carryover',
          )
        }
        const pvSec = req.pv.sections?.find((s) => s.sec_fp === secFp)
        const snapSec = req.snapshot.segmenter_output?.sections.find((s) => s.sec_fp === secFp)
        if (!pvSec?.body_fp || !snapSec?.body_fp) {
          return failMatch(req.fact_class, requiredKeys, matchedKeys, 'missing_required_fingerprint')
        }
        if (pvSec.body_fp !== snapSec.body_fp) {
          return failMatch(req.fact_class, requiredKeys, matchedKeys, 'fingerprint_mismatch')
        }
        // If 128-bit digest is also carried on PV, enforce exact 128-bit match too (§6.1)
        if (pvSec.body_digest_128 && pvSec.body_digest_128 !== snapSec.body_digest_128) {
          return failMatch(req.fact_class, requiredKeys, matchedKeys, 'fingerprint_mismatch')
        }
        matchedKeys.push('body_fp')
        break
      }

      case 'el_fp': {
        const elFp = req.target_el_fp
        if (!elFp) {
          return failMatch(req.fact_class, requiredKeys, matchedKeys, 'missing_required_fingerprint')
        }
        const pvHas = req.pv.element_fps?.includes(elFp) ?? false
        const snapHas =
          req.snapshot.segmenter_output?.elements.some((e) => e.el_fp === elFp) ?? false
        if (!pvHas || !snapHas) {
          return failMatch(req.fact_class, requiredKeys, matchedKeys, 'fingerprint_mismatch')
        }
        matchedKeys.push('el_fp')
        break
      }
    }
  }

  return Object.freeze({
    matched: true,
    status: 'ok',
    fact_class: req.fact_class,
    snapshot_id: req.snapshot.snapshot_id,
    checked_keys: requiredKeys,
    matched_keys: Object.freeze(matchedKeys),
    volatile_identity_only: volatileIdentityOnly,
    reason: 'exact_fingerprint_match',
  })
}

function failMatch(
  factClass: FactInputClass,
  checkedKeys: readonly FingerprintKeyName[],
  matchedKeys: readonly FingerprintKeyName[],
  reason: ExactJoinFailureReason,
): ExactFingerprintJoinResult {
  return Object.freeze({
    matched: false,
    status: 'unmatched',
    fact_class: factClass,
    snapshot_id: null,
    checked_keys: checkedKeys,
    matched_keys: Object.freeze([...matchedKeys]),
    volatile_identity_only: false,
    reason,
  })
}

/**
 * 候補スナップショット一覧から、時刻の近さだけでなく「事実種別が要求する照合キーの完全一致」を
 * 満たす最寄りの不変スナップショットを選定する。一致が無ければ決して時間で妥協しない。
 */
export function selectMatchingSnapshotForFact(params: {
  readonly pv: PvFingerprintBundle
  readonly snapshots: readonly ImmutableStructureSnapshot[]
  readonly fact_class: FactInputClass
  readonly target_sec_fp?: string
  readonly target_el_fp?: string
  readonly measured_geometry_drift_G?: number | null
}): ExactFingerprintJoinResult {
  if (params.pv.dom_state === 'private_scope') {
    return Object.freeze({
      matched: false,
      status: 'not_collected',
      fact_class: params.fact_class,
      snapshot_id: null,
      checked_keys: FACT_REQUIRED_FINGERPRINTS[params.fact_class],
      matched_keys: Object.freeze([]),
      volatile_identity_only: false,
      reason: 'private_scope_not_collected',
    })
  }

  const pvMs = Date.parse(params.pv.observed_at)
  let best: { res: ExactFingerprintJoinResult; distMs: number } | null = null

  for (const snap of params.snapshots) {
    const res = matchPvToSnapshot({
      pv: params.pv,
      snapshot: snap,
      fact_class: params.fact_class,
      target_sec_fp: params.target_sec_fp,
      target_el_fp: params.target_el_fp,
      measured_geometry_drift_G: params.measured_geometry_drift_G,
    })
    if (!res.matched) continue

    const snapMs = Date.parse(snap.rendered_at)
    const distMs = Number.isNaN(pvMs) || Number.isNaN(snapMs) ? 0 : Math.abs(pvMs - snapMs)
    if (best === null || distMs < best.distMs) {
      best = { res, distMs }
    }
  }

  if (best) return best.res

  return Object.freeze({
    matched: false,
    status: 'unmatched',
    fact_class: params.fact_class,
    snapshot_id: null,
    checked_keys: FACT_REQUIRED_FINGERPRINTS[params.fact_class],
    matched_keys: Object.freeze([]),
    volatile_identity_only: false,
    reason: 'no_matching_snapshot',
  })
}
