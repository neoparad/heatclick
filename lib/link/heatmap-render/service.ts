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
  type UntrustedValue,
} from '@/packages/contract/response'
import { computeUrlKeyV2 } from '@/packages/contract/urlkey'

import {
  validateActorBucketForHeatmap,
  type ModelInferredDisclosureHeader,
} from './actor-experiment'
import { evaluateHeatmapConsentEligibility } from './consent-matrix'
import { decideHeatmapRenderKind, renderDeterministicHeatmapImage } from './renderer'
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

function isCalendarAlignedIsoRange(startIso: string, endIso: string): boolean {
  const s = new Date(startIso)
  const e = new Date(endIso)
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) return false
  return (
    s.getUTCHours() === 0 &&
    s.getUTCMinutes() === 0 &&
    s.getUTCSeconds() === 0 &&
    e.getUTCHours() === 0 &&
    e.getUTCMinutes() === 0 &&
    e.getUTCSeconds() === 0
  )
}

function symmetricDifferenceSize(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let diff = 0
  for (const id of a) if (!b.has(id)) diff++
  for (const id of b) if (!a.has(id)) diff++
  return diff
}

export class HeatmapDisclosureGuard {
  /** Tracks prior disclosed subject sets per (principal, tenant, site, page) to stop differencing attacks */
  private readonly history = new Map<
    string,
    Array<{ readonly segment_id: string; readonly subjects: ReadonlySet<string>; readonly total: number }>
  >()

  evaluate(input: DisclosureCheckInput): DisclosureCheckResult {
    // Same-site owner export follows §5.12 without third-party k=10 suppression
    if (input.audience === 'site_owner') {
      return Object.freeze({
        allowed: true,
        blocked_differencing_attack: false,
        non_calendar_period_rejected: false,
        suppressed_cell_count: 0,
        sections: input.sections,
        clicks: input.clicks,
        reason: 'site_owner_self_access',
      })
    }

    // External party rule 1: strict calendar-aligned UTC period (§11.3 / §11.12)
    if (!isCalendarAlignedIsoRange(input.period_start, input.period_end)) {
      return Object.freeze({
        allowed: false,
        blocked_differencing_attack: false,
        non_calendar_period_rejected: true,
        suppressed_cell_count: input.sections.length + input.clicks.length,
        sections: Object.freeze([]),
        clicks: Object.freeze([]),
        reason: 'external_party_requires_calendar_aligned_period',
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
        reason: 'segment_below_k10_threshold',
      })
    }

    // External party rule 3: Sequential overlapping-segment differencing attack defense!
    const hKey = `${input.principal_id}|${input.tenant_id}|${input.site_id}|${input.page_url_key}`
    const prior = this.history.get(hKey) ?? []
    const currentSet = input.subject_ids ? new Set(input.subject_ids) : null

    for (const prev of prior) {
      if (prev.segment_id === input.segment_id) continue
      if (currentSet && prev.subjects.size > 0) {
        const symDiff = symmetricDifferenceSize(prev.subjects, currentSet)
        if (symDiff > 0 && symDiff < EXTERNAL_PARTY_MIN_CELL_K) {
          return Object.freeze({
            allowed: false,
            blocked_differencing_attack: true,
            non_calendar_period_rejected: false,
            suppressed_cell_count: input.sections.length + input.clicks.length,
            sections: Object.freeze([]),
            clicks: Object.freeze([]),
            reason: `differencing_attack_blocked:symmetric_diff=${symDiff}<${EXTERNAL_PARTY_MIN_CELL_K}`,
          })
        }
      } else {
        const countDiff = Math.abs(prev.total - input.total_units)
        if (countDiff > 0 && countDiff < EXTERNAL_PARTY_MIN_CELL_K) {
          return Object.freeze({
            allowed: false,
            blocked_differencing_attack: true,
            non_calendar_period_rejected: false,
            suppressed_cell_count: input.sections.length + input.clicks.length,
            sections: Object.freeze([]),
            clicks: Object.freeze([]),
            reason: `differencing_attack_blocked:count_diff=${countDiff}<${EXTERNAL_PARTY_MIN_CELL_K}`,
          })
        }
      }
    }

    // External party rule 4: Primary cell suppression (<10) + Secondary complementary suppression
    let suppressedCount = 0
    const primarySuppressedSections = new Set<number>()
    input.sections.forEach((s, idx) => {
      if (s.reach_pvs < EXTERNAL_PARTY_MIN_CELL_K || s.dwell_pvs < EXTERNAL_PARTY_MIN_CELL_K) {
        primarySuppressedSections.add(idx)
      }
    })
    // Complementary suppression: if exactly 1 section cell is suppressed, suppress the next smallest too so total cannot leak it!
    if (primarySuppressedSections.size === 1 && input.sections.length >= 2) {
      let minIdx = -1
      let minPvs = Infinity
      input.sections.forEach((s, idx) => {
        if (!primarySuppressedSections.has(idx) && s.reach_pvs < minPvs) {
          minPvs = s.reach_pvs
          minIdx = idx
        }
      })
      if (minIdx !== -1) primarySuppressedSections.add(minIdx)
    }

    const safeSections = input.sections.map((s, idx): HeatmapSectionMetricInput => {
      if (primarySuppressedSections.has(idx)) {
        suppressedCount++
        return Object.freeze({
          ...s,
          reach_rate: null,
          dwell_center40_ms: null,
          status: 'suppressed',
        })
      }
      return s
    })

    const primarySuppressedClicks = new Set<number>()
    input.clicks.forEach((c, idx) => {
      if (c.click_count < EXTERNAL_PARTY_MIN_CELL_K) primarySuppressedClicks.add(idx)
    })
    if (primarySuppressedClicks.size === 1 && input.clicks.length >= 2) {
      let minIdx = -1
      let minCnt = Infinity
      input.clicks.forEach((c, idx) => {
        if (!primarySuppressedClicks.has(idx) && c.click_count < minCnt) {
          minCnt = c.click_count
          minIdx = idx
        }
      })
      if (minIdx !== -1) primarySuppressedClicks.add(minIdx)
    }

    const safeClicks = input.clicks.map((c, idx): HeatmapClickPointInput => {
      if (primarySuppressedClicks.has(idx)) {
        suppressedCount++
        return Object.freeze({
          ...c,
          click_count: 0,
          status: 'suppressed',
        })
      }
      return c
    })

    // Record query into differencing guard ledger
    prior.push({
      segment_id: input.segment_id,
      subjects: currentSet ?? new Set(),
      total: input.total_units,
    })
    this.history.set(hKey, prior)

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
  readonly model_inferred_header?: {
    readonly likelihood_ratio: number
    readonly fpr_upper_bound: number
    readonly certificate_id: string
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
  readonly png_bytes: Uint8Array | null
  readonly deletion_epoch: number
  readonly build_seq: number
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
   * 削除イベント発生時: 世代を進めて派生画像・キャッシュを即時失効する (§11.12)。
   */
  invalidateOnDeletion(tenantId: string, siteId: string, pageUrlOrKey: string): number {
    const urlKey = pageUrlOrKey.includes('://')
      ? computeUrlKeyV2(pageUrlOrKey).url_key_v2
      : pageUrlOrKey
    const pk = this.pageScopeKey(tenantId, siteId, urlKey)
    const nextEpoch = (this.deletionEpochs.get(pk) ?? 0) + 1
    this.deletionEpochs.set(pk, nextEpoch)
    this.evictStaleArtifacts(tenantId, siteId, urlKey)
    return nextEpoch
  }

  /**
   * 集計再構築 (`build_seq` 更新) 時: 派生画像・キャッシュを即時失効する (§11.12)。
   */
  invalidateOnRebuild(tenantId: string, siteId: string, pageUrlOrKey: string): number {
    const urlKey = pageUrlOrKey.includes('://')
      ? computeUrlKeyV2(pageUrlOrKey).url_key_v2
      : pageUrlOrKey
    const pk = this.pageScopeKey(tenantId, siteId, urlKey)
    const nextSeq = (this.buildSeqs.get(pk) ?? 1) + 1
    this.buildSeqs.set(pk, nextSeq)
    this.evictStaleArtifacts(tenantId, siteId, urlKey)
    return nextSeq
  }

  private evictStaleArtifacts(tenantId: string, siteId: string, urlKey: string): void {
    for (const [hash, entry] of this.artifactsByReproHash.entries()) {
      if (
        entry.tenant_id === tenantId &&
        entry.site_id === siteId &&
        entry.page_url_key === urlKey
      ) {
        this.artifactsByReproHash.delete(hash)
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
   * 保存済み成果物の取得（毎回認証＋削除/再集計世代の再確認）。
   */
  fetchArtifactById(params: {
    readonly principal: HeatmapFetchPrincipal | null
    readonly artifact_id: string
    readonly signed_url_token_only?: boolean
    readonly now_iso: string
  }): {
    readonly http_status: 200 | 401 | 403 | 404 | 410
    readonly artifact: RenderedHeatmapUnitArtifact | null
    readonly png_bytes: Uint8Array | null
    readonly reason: string
  } {
    const entry = this.artifactsById.get(params.artifact_id)
    if (!entry) {
      return Object.freeze({
        http_status: 404,
        artifact: null,
        png_bytes: null,
        reason: 'artifact_not_found',
      })
    }

    const auth = this.authorizeArtifactFetch({
      principal: params.principal,
      target_tenant_id: entry.tenant_id,
      target_site_id: entry.site_id,
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

    // Re-check deletion_epoch & build_seq on every fetch (and before pending job publish!)
    const pk = this.pageScopeKey(entry.tenant_id, entry.site_id, entry.page_url_key)
    const curDelEpoch = this.deletionEpochs.get(pk) ?? 0
    const curBuildSeq = this.buildSeqs.get(pk) ?? 1
    if (entry.deletion_epoch < curDelEpoch || entry.build_seq < curBuildSeq) {
      this.artifactsById.delete(params.artifact_id)
      return Object.freeze({
        http_status: 410,
        artifact: null,
        png_bytes: null,
        reason:
          entry.deletion_epoch < curDelEpoch
            ? 'artifact_invalidated_by_deletion'
            : 'artifact_invalidated_by_rebuild',
      })
    }

    return Object.freeze({
      http_status: 200,
      artifact: entry.artifact,
      png_bytes: entry.png_bytes,
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

    // 3. Cost & abuse reservation BEFORE work (§11.12)
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

        // Wrap any OCR / embedded text as UntrustedValue so prompt injection cannot touch auth/dest/budget!
        const untrustedEmbeddedTexts: UntrustedValue[] = (
          dataset.screenshot?.embedded_text_samples ?? []
        ).map((txt) => wrapUntrusted(txt, 'heatmap_text'))

        const unitKeyStr = serializeHeatmapUnitKey(dataset.unit)
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
              sections: dataset.sections,
              clicks: dataset.clicks,
              http: dataset.http_fetch_metrics ?? null,
              consent: consentEval.status,
              audience: principal.audience,
            }),
          )
          .digest('hex')
        const reproHash = computeReproducibilityHash(
          dataset.unit,
          req.kind,
          req.actor_bucket,
          dataset.repro_inputs,
          metricsDigest,
        )

        // Reuse cached deterministic artifact if exact same reproHash & current generation!
        const cached = this.artifactsByReproHash.get(
          `${req.tenant_id}|${req.site_id}|${principal.audience}|${reproHash}`,
        )
        if (
          cached &&
          cached.deletion_epoch === curDelEpoch &&
          cached.build_seq === curBuildSeq
        ) {
          artifacts.push(Object.freeze({ ...cached.artifact, cache_hit: true }))
          continue
        }

        // Unified disclosure & differencing attack check
        const disclosure = this.disclosureGuard.evaluate({
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
        })

        if (!disclosure.allowed) {
          if (disclosure.blocked_differencing_attack) anyDifferencingBlocked = true
          const supArt = this.buildNonImageArtifact({
            req,
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

        // Overlay vs wireframe vs http_fetch vs none/pending decision
        const kindDecision = decideHeatmapRenderKind(dataset, req.actor_bucket)
        if (kindDecision.render_kind === 'none') {
          if (kindDecision.status === 'pending') anyPending = true
          const noImgArt = this.buildNonImageArtifact({
            req,
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

        const entry: StoredArtifactEntry = {
          artifact,
          tenant_id: req.tenant_id,
          site_id: req.site_id,
          page_url_key: urlKey,
          png_bytes: rendered.png_bytes,
          deletion_epoch: curDelEpoch,
          build_seq: curBuildSeq,
        }
        this.artifactsById.set(artifactId, entry)
        this.artifactsByReproHash.set(
          `${req.tenant_id}|${req.site_id}|${principal.audience}|${reproHash}`,
          entry,
        )
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
      untrusted_embedded_texts: Object.freeze(params.untrustedEmbeddedTexts),
      cache_hit: false,
      deletion_epoch: params.deletionEpoch,
      build_seq: params.buildSeq,
      envelope,
    })
  }

  private buildUnitEnvelope(params: {
    readonly req: HeatmapRenderRequest
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

    const measure: MeasureInput = {
      value: isOk
        ? createDataLayerMetric(params.dataset.total_units_in_segment, refId, {
            authority: 'data_layer',
            createdAt: params.req.requested_at,
          })
        : null,
      unit: 'pv',
      status: params.status,
      ...(isOk ? {} : { reason: params.limitations[0] ?? params.status }),
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
      sample: isOk ? { n: params.dataset.total_units_in_segment, unit_kind: 'pv' } : null,
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
        denominator_n: params.dataset.total_units_in_segment,
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
