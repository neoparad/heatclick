/**
 * UGOKI LINK v2 — 束 4-D (§8.13 #6): 会員要約ストア & 強い整合性「利用停止印・世代ガード」
 *
 * 設計書 §8.13 #6 / §5.7:
 * - ログイン会員の要約（数 KB 以下: 最近買った商品・カテゴリ関心・再購入候補・除外一覧）をサーバー側のみに保持。
 * - 履歴利用には「会員連携 (`member_link`)」と「個別最適化 (`personalisation`)」の両方の同意が必須。
 *   どちらかが欠ければ未ログイン相当 (`null`) にフォールバックする。
 * - 削除依頼・同意撤回時に、強い整合性ストアへ `suppression_epoch` を即時確定し要約を削除する。
 * - 要約夜間再生成・注文通知再送・過去分取込・バックアップ復元はすべて `data_epoch` と
 *   `suppression_epoch` を照合し、古い世代 (`data_epoch <= suppression_epoch`) の書き戻しを完全拒否する。
 * - 要約の保持期限 (`retention_expires_at`) は元注文データから引き継ぎ、夜間更新で決して延長しない。
 */

export interface EcMemberSummary {
  readonly tenant_id: string
  readonly site_id: string
  readonly member_key: string
  readonly generation_epoch: number
  readonly recent_purchased_product_ids: readonly string[]
  readonly category_affinity: Readonly<Record<string, number>>
  readonly upcoming_repurchase_product_ids: readonly string[]
  readonly excluded_product_ids: readonly string[]
  /** Inherited from source order data — NEVER extended by nightly rebuild (§8.13 #6) */
  readonly retention_expires_at: string
  readonly updated_at: string
}

export interface MemberSuppressionMark {
  readonly tenant_id: string
  readonly site_id: string
  readonly member_key: string
  readonly suppression_epoch: number
  readonly reason: 'deletion_request' | 'consent_revoked'
  readonly suppressed_at: string
}

export type MemberWriteSource =
  | 'nightly_summary_rebuild'
  | 'order_notification'
  | 'historical_order_backfill'
  | 'backup_restore'

export interface MemberWriteResult {
  readonly accepted: boolean
  readonly summary: EcMemberSummary | null
  readonly rejection_reason?:
    | 'rejected_by_suppression_epoch'
    | 'stale_data_epoch'
    | 'retention_expired'
}

export class EcMemberSummaryStore {
  private readonly summaries = new Map<string, EcMemberSummary>()
  private readonly suppressions = new Map<string, MemberSuppressionMark>()
  private readonly siteMaxEpoch = new Map<string, number>()

  private key(tenantId: string, siteId: string, memberKey: string): string {
    return `${tenantId}|${siteId}|${memberKey}`
  }

  private siteKey(tenantId: string, siteId: string): string {
    return `${tenantId}|${siteId}`
  }

  /**
   * 削除依頼・同意撤回時に強い整合性ストアへ利用停止印 (`suppression_epoch`) を即時確定し要約を削除する。
   * 初回書込到着前の事前削除 (pre-insert deletion tombstone) でもサイト最高世代+1 と削除時刻を記録し、
   * 実行中の遅延ワーカーによる復活 (resurrection) を完全阻止する (§8.13 #6)。
   */
  recordMemberSuppression(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly member_key: string
    readonly reason: MemberSuppressionMark['reason']
    readonly suppressed_at: string
    /** Optional explicit epoch >= current; defaults to current max epoch + 1 */
    readonly explicit_epoch?: number
  }): MemberSuppressionMark {
    const k = this.key(params.tenant_id, params.site_id, params.member_key)
    const sk = this.siteKey(params.tenant_id, params.site_id)
    const prevMark = this.suppressions.get(k)
    const prevSummary = this.summaries.get(k)
    const siteHighWater = this.siteMaxEpoch.get(sk) ?? 0
    const currentMax = Math.max(
      prevMark?.suppression_epoch ?? 0,
      prevSummary?.generation_epoch ?? 0,
      siteHighWater,
    )
    const nextEpoch = Math.max(currentMax + 1, params.explicit_epoch ?? currentMax + 1)

    const mark: MemberSuppressionMark = Object.freeze({
      tenant_id: params.tenant_id,
      site_id: params.site_id,
      member_key: params.member_key,
      suppression_epoch: nextEpoch,
      reason: params.reason,
      suppressed_at: params.suppressed_at,
    })

    this.suppressions.set(k, mark)
    this.siteMaxEpoch.set(sk, Math.max(siteHighWater, nextEpoch))
    this.summaries.delete(k)
    return mark
  }

  /** Alias for `recordMemberSuppression` (`deletion_request` default). */
  deleteMember(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly member_key: string
    readonly suppressed_at: string
    readonly reason?: MemberSuppressionMark['reason']
    readonly explicit_epoch?: number
  }): MemberSuppressionMark {
    return this.recordMemberSuppression({
      tenant_id: params.tenant_id,
      site_id: params.site_id,
      member_key: params.member_key,
      reason: params.reason ?? 'deletion_request',
      suppressed_at: params.suppressed_at,
      explicit_epoch: params.explicit_epoch,
    })
  }

  getSuppressionMark(
    tenantId: string,
    siteId: string,
    memberKey: string,
  ): MemberSuppressionMark | null {
    return this.suppressions.get(this.key(tenantId, siteId, memberKey)) ?? null
  }

  private isSuppressedWrite(k: string, dataEpoch: number, writeTimestampIso: string): boolean {
    const mark = this.suppressions.get(k)
    if (!mark) return false
    if (!Number.isInteger(dataEpoch) || dataEpoch <= mark.suppression_epoch) {
      return true
    }
    const writeMs = Date.parse(writeTimestampIso)
    const supMs = Date.parse(mark.suppressed_at)
    if (!Number.isFinite(writeMs) || (Number.isFinite(supMs) && writeMs <= supMs)) {
      return true
    }
    return false
  }

  /**
   * 要約の書込・更新（夜間再生成・過去取込・バックアップ復元すべて共通の世代ガードを通過させる）。
   */
  upsertSummary(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly member_key: string
    readonly data_epoch: number
    readonly write_source: MemberWriteSource
    readonly recent_purchased_product_ids: readonly string[]
    readonly category_affinity: Readonly<Record<string, number>>
    readonly upcoming_repurchase_product_ids: readonly string[]
    readonly excluded_product_ids: readonly string[]
    /** Retention deadline inherited from source orders */
    readonly source_retention_expires_at: string
    readonly updated_at: string
  }): MemberWriteResult {
    const k = this.key(params.tenant_id, params.site_id, params.member_key)
    const sk = this.siteKey(params.tenant_id, params.site_id)

    if (!Number.isInteger(params.data_epoch) || params.data_epoch < 1) {
      return Object.freeze({
        accepted: false,
        summary: null,
        rejection_reason: 'stale_data_epoch',
      })
    }

    // Guard 1: Reject suppressed epoch OR pre-deletion timestamp across rebuild / replay / backfill / backup restore (§8.13 #6)
    if (this.isSuppressedWrite(k, params.data_epoch, params.updated_at)) {
      return Object.freeze({
        accepted: false,
        summary: null,
        rejection_reason: 'rejected_by_suppression_epoch',
      })
    }

    // Guard 2: Monotonic data_epoch — NEVER regress an existing active member summary to an older epoch!
    const existing = this.summaries.get(k)
    if (existing) {
      if (params.data_epoch < existing.generation_epoch) {
        return Object.freeze({
          accepted: false,
          summary: null,
          rejection_reason: 'stale_data_epoch',
        })
      }
      if (
        params.data_epoch === existing.generation_epoch &&
        params.write_source !== 'order_notification' &&
        Date.parse(params.updated_at) < Date.parse(existing.updated_at)
      ) {
        return Object.freeze({
          accepted: false,
          summary: null,
          rejection_reason: 'stale_data_epoch',
        })
      }
    }

    // Guard 3: Never extend retention_expires_at past existing source deadline
    const effectiveRetention =
      existing &&
      Date.parse(existing.retention_expires_at) < Date.parse(params.source_retention_expires_at)
        ? existing.retention_expires_at
        : params.source_retention_expires_at

    if (Date.parse(effectiveRetention) <= Date.parse(params.updated_at)) {
      this.summaries.delete(k)
      return Object.freeze({
        accepted: false,
        summary: null,
        rejection_reason: 'retention_expired',
      })
    }

    const summary: EcMemberSummary = Object.freeze({
      tenant_id: params.tenant_id,
      site_id: params.site_id,
      member_key: params.member_key,
      generation_epoch: params.data_epoch,
      recent_purchased_product_ids: Object.freeze([...new Set(params.recent_purchased_product_ids)]),
      category_affinity: Object.freeze({ ...params.category_affinity }),
      upcoming_repurchase_product_ids: Object.freeze([
        ...new Set(params.upcoming_repurchase_product_ids),
      ]),
      excluded_product_ids: Object.freeze([...new Set(params.excluded_product_ids)]),
      retention_expires_at: effectiveRetention,
      updated_at: params.updated_at,
    })

    this.summaries.set(k, summary)
    this.siteMaxEpoch.set(sk, Math.max(this.siteMaxEpoch.get(sk) ?? 0, params.data_epoch))
    return Object.freeze({ accepted: true, summary })
  }

  /**
   * 注文通知による即時更新（「最近買った商品」と「除外一覧」のみ即反映、世代ガード必須）。
   */
  applyOrderNotification(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly member_key: string
    readonly order_status: 'placed' | 'returned' | 'cancelled'
    readonly product_ids: readonly string[]
    readonly data_epoch: number
    readonly occurred_at: string
    readonly default_retention_days?: number
  }): MemberWriteResult {
    const k = this.key(params.tenant_id, params.site_id, params.member_key)
    if (this.isSuppressedWrite(k, params.data_epoch, params.occurred_at)) {
      return Object.freeze({
        accepted: false,
        summary: null,
        rejection_reason: 'rejected_by_suppression_epoch',
      })
    }

    const existing = this.summaries.get(k)
    if (existing && params.data_epoch < existing.generation_epoch) {
      return Object.freeze({
        accepted: false,
        summary: null,
        rejection_reason: 'stale_data_epoch',
      })
    }
    const retentionDays = params.default_retention_days ?? 395
    const fallbackRetention = new Date(
      Date.parse(params.occurred_at) + retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString()

    const currentRecent = new Set(existing?.recent_purchased_product_ids ?? [])
    const currentExcluded = new Set(existing?.excluded_product_ids ?? [])

    if (params.order_status === 'placed') {
      for (const pid of params.product_ids) {
        currentRecent.add(pid)
        currentExcluded.add(pid)
      }
    } else {
      // Returned / cancelled -> remove from recent & excluded
      for (const pid of params.product_ids) {
        currentRecent.delete(pid)
        currentExcluded.delete(pid)
      }
    }

    return this.upsertSummary({
      tenant_id: params.tenant_id,
      site_id: params.site_id,
      member_key: params.member_key,
      data_epoch: params.data_epoch,
      write_source: 'order_notification',
      recent_purchased_product_ids: [...currentRecent],
      category_affinity: existing?.category_affinity ?? {},
      upcoming_repurchase_product_ids: existing?.upcoming_repurchase_product_ids ?? [],
      excluded_product_ids: [...currentExcluded],
      source_retention_expires_at: existing?.retention_expires_at ?? fallbackRetention,
      updated_at: params.occurred_at,
    })
  }

  /**
   * 推薦用要約読み取り: `member_link` と `personalisation` の両同意＋非停止確認が揃う時のみ返却。
   */
  readSummaryForRecommendation(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly member_key: string
    readonly consent_member_link: boolean
    readonly consent_personalisation: boolean
    readonly now_iso: string
  }): { readonly summary: EcMemberSummary | null; readonly fallback_reason: string | null } {
    if (!params.consent_member_link || !params.consent_personalisation) {
      return Object.freeze({
        summary: null,
        fallback_reason: 'missing_required_dual_consent_fallback_anonymous',
      })
    }

    const k = this.key(params.tenant_id, params.site_id, params.member_key)
    const summary = this.summaries.get(k)
    if (!summary) {
      return Object.freeze({ summary: null, fallback_reason: 'no_summary' })
    }

    if (this.isSuppressedWrite(k, summary.generation_epoch, summary.updated_at)) {
      return Object.freeze({ summary: null, fallback_reason: 'member_suppressed' })
    }

    if (Date.parse(summary.retention_expires_at) <= Date.parse(params.now_iso)) {
      return Object.freeze({ summary: null, fallback_reason: 'retention_expired' })
    }

    return Object.freeze({ summary, fallback_reason: null })
  }
}
