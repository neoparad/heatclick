/**
 * Owner Decision Ledger (Master Architecture v2 §14: Decisions 1–31)
 *
 * Single source of truth for owner decisions, prior-decision revisions,
 * and `not_entitled` runtime guards (Implementation Plan §4, Handoff §4).
 *
 * 2026-11-20 recorded owner decisions (Handoff §4 / Master Architecture v2 §14.3 #31):
 *   - D-31a (Foundation models): decided / approved (Muse Glimmer 30B vs Gemma 4 evaluated in-house)
 *   - D-31b (Jev output for ML training): decided / prohibited (PERMANENT LOCK — forbidden for
 *     both customer and own-site data; no vendor exception requested; no training pipeline built)
 *   - D-31c (Production inference compute for generative model; §14.3 31(d) / OWNER_TODO 31-c):
 *     decided / approved
 *   - D-31d (Shared cross-tenant fine-tuning on tenant page text; §14.3 31(c) / OWNER_TODO 31-d):
 *     pending / undecided (own-site text only until decided)
 */

export type LedgerArea = 'tel' | 'store' | 'join' | 'act' | 'ml' | 'ev' | 'del' | 'surf'

export type DecisionCategory = 'initial_priority' | 'prior_revision' | 'new_approval'

export type DecisionStatus = 'decided' | 'pending'

export type DecisionOutcome = 'approved' | 'prohibited' | 'undecided'

export type DecisionId =
  | 'D-01'
  | 'D-02'
  | 'D-03'
  | 'D-04'
  | 'D-05'
  | 'D-06'
  | 'D-07'
  | 'D-08'
  | 'D-09'
  | 'D-10'
  | 'D-11'
  | 'D-12'
  | 'D-13'
  | 'D-14'
  | 'D-15'
  | 'D-16'
  | 'D-17'
  | 'D-18'
  | 'D-19'
  | 'D-20'
  | 'D-21'
  | 'D-22'
  | 'D-23'
  | 'D-24'
  | 'D-25'
  | 'D-26'
  | 'D-27'
  | 'D-28'
  | 'D-29'
  | 'D-30'
  | 'D-31a'
  | 'D-31b'
  | 'D-31c'
  | 'D-31d'

export interface OwnerDecision {
  readonly id: DecisionId
  readonly number: number
  readonly subId?: 'a' | 'b' | 'c' | 'd'
  readonly category: DecisionCategory
  readonly title: string
  readonly owningArea: LedgerArea
  readonly specRef: string
  readonly priorDecisionRef?: string
  readonly consistencyOrderIds: ReadonlyArray<string>
  readonly status: DecisionStatus
  readonly outcome: DecisionOutcome
  readonly decidedAt: string | null
  readonly legalSignOffRequired: boolean
  readonly legalSignedOff: boolean
  readonly deadlineStep: string
  readonly recommendedOption: string
  readonly fallbackWhenPending: string
  readonly blockedCapabilities: ReadonlyArray<string>
  readonly notes?: string
}

export type DecisionEntitlementResult =
  | {
      readonly entitled: true
      readonly status: 'ok'
      readonly decisionId: DecisionId
      readonly outcome: 'approved'
      readonly decidedAt: string
    }
  | {
      readonly entitled: false
      readonly status: 'not_entitled'
      readonly decisionId: string
      readonly reason:
        | 'unknown_decision'
        | 'decision_pending'
        | 'prohibited_by_decision'
        | 'legal_signoff_pending'
      readonly message: string
      readonly unlockRequirement: string
    }

export class NotEntitledError extends Error {
  readonly status = 'not_entitled' as const
  readonly decisionId: string
  readonly reason: 'unknown_decision' | 'decision_pending' | 'prohibited_by_decision' | 'legal_signoff_pending'
  readonly unlockRequirement: string

  constructor(result: Extract<DecisionEntitlementResult, { entitled: false }>) {
    super(result.message)
    this.name = 'NotEntitledError'
    this.decisionId = result.decisionId
    this.reason = result.reason
    this.unlockRequirement = result.unlockRequirement
  }
}

export const DECISIONS_LEDGER: ReadonlyArray<OwnerDecision> = [
  // ===== §14.1 先に要る 6 件 =====
  {
    id: 'D-01',
    number: 1,
    category: 'initial_priority',
    title: '日本での同意の扱い（法務確認・署名・告知＋オプトアウトでの長期訪問者ID）',
    owningArea: 'tel',
    specRef: '§4.5 / §14.1 #1',
    priorDecisionRef: 'H-6 / 2026-04-28 法務確認更新',
    consistencyOrderIds: ['O-12'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: true,
    legalSignedOff: false,
    deadlineStep: 'Q-11 前（計測開始前・最優先）',
    recommendedOption: '日本の法域行を「告知＋オプトアウトで full / 30分ローリングセッション」として法務確認・署名する',
    fallbackWhenPending: '自社5サイトは cookieless で稼働（PV単位実験のみ、表示回数上限を要する被せ表示・文言/価格/オファー実験・クロスセッション経路は not_collected / not_entitled）',
    blockedCapabilities: [
      'session_and_visitor_units',
      'identity_stratum_a',
      'cross_session_frequency_caps',
      'copy_price_offer_experiments',
      'cumulative_holdout_claims',
    ],
  },
  {
    id: 'D-02',
    number: 2,
    category: 'initial_priority',
    title: '本番通信での計測タグ比較群の無作為割当承認（最小版/軽量版/全部版・旧新並行・2秒監査群）',
    owningArea: 'tel',
    specRef: '§4.8 / §14.1 #2',
    consistencyOrderIds: ['O-11'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: false,
    legalSignedOff: false,
    deadlineStep: 'Q-11 前（計測開始前）',
    recommendedOption: '本番トラフィックでの無作為割当を承認し、Stage B の全部版群は「検証専用：配信可＝半々」または「全量検証専用」を選択する',
    fallbackWhenPending: 'SDK 重さ検定 (tel.G16) と旧新換算比 (tel.G18) を主張できず、配信描画ゲートが開かない',
    blockedCapabilities: ['production_dual_run_stage_a', 'sdk_weight_qualification_stage_b', 'audit_arm_heartbeat'],
  },
  {
    id: 'D-03',
    number: 3,
    category: 'initial_priority',
    title: '顧客 CDN 上で動かす単一ゾーン Worker の自社 5 サイト導入',
    owningArea: 'del',
    specRef: '§7.3 / §10.1 / §12.1 #3 / §14.1 #3',
    consistencyOrderIds: ['O-7', 'O-10'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: false,
    legalSignedOff: false,
    deadlineStep: 'Q-6 / Q-10 前',
    recommendedOption: '自社 Cloudflare アカウントに顧客配備方式で単一ゾーン Worker（capture/handoff/origin_kit/deliver）を導入する',
    fallbackWhenPending: 'タグ単独導入に留まり、非JSクローラーは not_collected、PV 偽造耐性・エッジ書き換え・Server-Timing 受け渡し不可',
    blockedCapabilities: ['edge_capture_p1', 'edge_handoff', 'proxied_origin_kit', 'edge_html_rewrite'],
  },
  {
    id: 'D-04',
    number: 4,
    category: 'initial_priority',
    title: '単一 WordPress プラグインの製品部品・信頼起点としての承認',
    owningArea: 'del',
    specRef: '§10.9 / §12.1 #3 / §14.1 #4',
    consistencyOrderIds: ['O-8'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: false,
    legalSignedOff: false,
    deadlineStep: 'Q-6 / Q-10 / Q-23 前',
    recommendedOption: 'オフライン署名リリース＋サイト側方針拘束の単一 WordPress プラグインを承認し自社サイトから導入する',
    fallbackWhenPending: '本採用・巻き戻しは人手または人承認の REST 経由に限定され、公開瞬間通知 content.changed やオリジンキット経路が使えない',
    blockedCapabilities: ['wp_plugin_adapter', 'wp_plugin_log_shipper', 'wp_publish_hook_content_changed', 'wp_origin_kit'],
  },
  {
    id: 'D-05',
    number: 5,
    category: 'initial_priority',
    title: '新保存用の専用 8 GiB 級 ClickHouse サーバー確保と旧システム停止日の設定',
    owningArea: 'store',
    specRef: '§5.5 / §14.1 #5',
    consistencyOrderIds: ['O-3'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: false,
    legalSignedOff: false,
    deadlineStep: 'Q-4 前 / Q-30 前',
    recommendedOption: '専用 8 GiB 級ノードを新設し、store.G-17 + 30 日で旧サーバーを廃止する計画を承認する',
    fallbackWhenPending: '既存 4.54 GiB サーバーでは新保存＋旧読取で予算 100% となり、ClickHouse 応答・store.G-8 が不安定化',
    blockedCapabilities: ['dedicated_v3_clickhouse_store', 'legacy_server_decommission'],
  },
  {
    id: 'D-06',
    number: 6,
    category: 'initial_priority',
    title: '決定記録先の一本化・ヘッドレス転換の正式記録・規則ファイル (CLAUDE.md) 更新',
    owningArea: 'surf',
    specRef: '§11.9 / §14.1 #6',
    priorDecisionRef: 'CLAUDE.md 規則3 (VWO委譲) / テナント分離 403→404',
    consistencyOrderIds: ['O-1', 'O-2'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: false,
    legalSignedOff: false,
    deadlineStep: 'Q-0 / Q-2 前',
    recommendedOption: '親戦略文書の決定ログを唯一の正とし、ヘッドレス転換・VWO 委譲規則廃止・他テナント 404+監査行への更新を正式記録する',
    fallbackWhenPending: '2 文書が正本を名乗る状態が残り、後続決定・レビュー基準が競合する',
    blockedCapabilities: ['unified_decision_governance', 'external_key_issuance_rules'],
  },

  // ===== §14.2 過去の決定の改定（7〜17） =====
  {
    id: 'D-07',
    number: 7,
    category: 'prior_revision',
    title: 'D-12 改定 (D-12R): 文言・価格・自由な案のテスト、自動配分、1 サイト結論の解禁',
    owningArea: 'ev',
    specRef: '§9.6 / §14.2 #7',
    priorDecisionRef: 'SSOT D-12 → D-12R',
    consistencyOrderIds: ['O-19'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: true,
    legalSignedOff: false,
    deadlineStep: 'Q-19 / Q-20 前',
    recommendedOption: 'アロケータ無作為化・事前登録ロック・完全性ゲート・価格/オファー法務署名を条件に D-12R を採用する',
    fallbackWhenPending: '機械的な 2 案 A/B のみに限定され、文言/価格/オファー・自動配分・1サイト proven は not_entitled',
    blockedCapabilities: [
      'freeform_variant_ab_tests',
      'copy_price_offer_variants',
      'adaptive_bandit_allocation',
      'single_site_proven_verdicts',
    ],
  },
  {
    id: 'D-08',
    number: 8,
    category: 'prior_revision',
    title: 'D-11 改定 (D-11R): 録画禁止の条項別整理（階層 0〜2・区画並び・テキスト預かり・検証済AI軌跡）',
    owningArea: 'tel',
    specRef: '§4.6 / §14.2 #8',
    priorDecisionRef: 'SSOT D-11 / H-5 → D-11R (条項 a〜h)',
    consistencyOrderIds: ['O-14'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: true,
    legalSignedOff: false,
    deadlineStep: '(b) t0 + 30日以内 / (e) Q-13 / (f) Q-22 / (c)(d)(g)(h) Q-28',
    recommendedOption: '条項 (a)(b)(e)(f)(g) を先行承認し、(c)(d)(h)（階層 1/2 整数時系列）は法務確認後に承認する',
    fallbackWhenPending: '階層 0（30日窓）のみ。pv_sequence は 30 日で消去され、階層 1/2 時系列・テキスト預かり・検証済AI操作軌跡は not_entitled',
    blockedCapabilities: [
      'pv_sequence_beyond_30d',
      'replay_tier1_kinematic_timeline',
      'replay_tier2_individual_handles',
      'aggregate_page_text_escrow',
      'verified_hosted_agent_action_trace',
    ],
  },
  {
    id: 'D-09',
    number: 9,
    category: 'prior_revision',
    title: 'D-07 改定 (D-07R): proven 未満での影響帯・較正済み予測幅の条件付き出力',
    owningArea: 'surf',
    specRef: '§9.10 / §14.2 #9',
    priorDecisionRef: 'SSOT D-07 → D-07R',
    consistencyOrderIds: ['O-28'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: false,
    legalSignedOff: false,
    deadlineStep: 'Q-27 前',
    recommendedOption: 'D-07R を採用（条件未達の間は D-07 と完全同一出力、30件以上・3サイト以上で的中率下限 ≥0.70 達成後に較正幅を解禁）',
    fallbackWhenPending: 'proven 未満での impact_band と calibrated projection interval は永久に not_entitled（現行 D-07 出力維持）',
    blockedCapabilities: ['calibrated_projection_interval', 'class_impact_band'],
  },
  {
    id: 'D-10',
    number: 10,
    category: 'prior_revision',
    title: '「顧客 MCP 書き込み不可」の改定（危険度階級 R0〜R5・パスキー承認・自律枠）',
    owningArea: 'surf',
    specRef: '§11.6 / §11.7 / §14.2 #10',
    priorDecisionRef: 'Customer MCP write = Never / Principle 6',
    consistencyOrderIds: ['O-15'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: false,
    legalSignedOff: false,
    deadlineStep: 'Q-12 / Q-19 / Q-26 前',
    recommendedOption: '分離ゲート・管理者パスキー承認・露出予算枠・開いた項目の人承認を条件に R0〜R5 書き込みを解禁する',
    fallbackWhenPending: 'MCP は R0 読み取り専用に制限され、操作系・公開系・OEM 系の書き込み道具は not_entitled',
    blockedCapabilities: ['mcp_write_r1_r3_r4', 'mcp_publish_r2_with_passkey', 'mcp_autonomous_envelope_publishing'],
  },
  {
    id: 'D-11',
    number: 11,
    category: 'prior_revision',
    title: 'A-15 改定 (A-15R): アフィリエイトリンクのクリック時発行者パラメータ付与・枠符号・ID 割当替',
    owningArea: 'join',
    specRef: '§6.5 / §14.2 #11',
    priorDecisionRef: 'SSOT A-15 → A-15R',
    consistencyOrderIds: ['O-16'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: true,
    legalSignedOff: false,
    deadlineStep: 'Q-14 前',
    recommendedOption: 'ネットワーク規約確認のうえ、行き先・パス・ネットワーク側パラメータ不変を条件にクリック時発行者サブパラメータ・枠符号を認める',
    fallbackWhenPending: 'slot_param / click_nonce / preset_id 回転は not_entitled（売上結合は注文明細・時刻照合・日次按分まで）',
    blockedCapabilities: ['affiliate_slot_param', 'affiliate_click_nonce', 'affiliate_preset_id_rotation'],
  },
  {
    id: 'D-12',
    number: 12,
    category: 'prior_revision',
    title: 'H-8 改定: IP アドレス 3 分類 (E/T/任意P)・サーバー証明優先・決定的証拠のみ学習除外',
    owningArea: 'act',
    specRef: '§7.9 / §14.2 #12',
    priorDecisionRef: 'SSOT H-8 / S12 優先順位 / S12 学習除外規則',
    consistencyOrderIds: ['O-9'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: true,
    legalSignedOff: false,
    deadlineStep: 'Q-8 / Q-10 前（計測開始前）',
    recommendedOption: '日次公開鍵封印・鍵破棄監査付きの E/T（および別途承認の任意 P）へ改定し、サーバー証明優先・決定的証拠のみ除外へ更新する',
    fallbackWhenPending: 'サーバー側アクセス観測行を保存できず（Q-10 が閉じない）、ネットワーク単位仮名 nc(scope, period) も構築不可',
    blockedCapabilities: ['server_access_observation_storage', 'network_pseudonym_facility', 'address_class_e_t_sealing', 'address_class_p_escalation'],
  },
  {
    id: 'D-13',
    number: 13,
    category: 'prior_revision',
    title: 'H-11: AI 回答全文の提供者別例外保存・市販 AI 自動操作検査・保留中クローラー監査の再開',
    owningArea: 'act',
    specRef: '§7.8 / §14.2 #13',
    priorDecisionRef: 'SSOT H-11 / 2026-07-02 保留監査',
    consistencyOrderIds: ['O-17'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: true,
    legalSignedOff: false,
    deadlineStep: 'Q-16 / Q-22 前',
    recommendedOption: '既定の非保存を維持しつつ、規約確認＋法務署名済み提供者のみ暗号化・期限付き例外保存を認め、保留監査を再開する',
    fallbackWhenPending: '引用 URL とスパンハッシュのみ保存、市販 AI の台本自動操作とカナリア面マトリクスは not_entitled',
    blockedCapabilities: ['ai_raw_answer_text_retention', 'scripted_consumer_agent_lab_runs', 'canary_surface_declaration_audit'],
  },
  {
    id: 'D-14',
    number: 14,
    category: 'prior_revision',
    title: 'I-1/I-2/I-7 改定: R2 生データ正本化・保持刻み・削除 SLA (24h非表示/5日消去/14日証明)・旧データ畳み込み',
    owningArea: 'store',
    specRef: '§5.2 / §5.7 / §14.2 #14',
    priorDecisionRef: 'SSOT I-1 / I-2 / I-3 / I-7',
    consistencyOrderIds: ['O-4', 'O-5', 'O-13', 'O-30'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: true,
    legalSignedOff: false,
    deadlineStep: 'Q-4 前（計測開始前）',
    recommendedOption: 'R2 フレームセグメントを保持期間内の生データ正本とし、公表保持グリッド（≤12値）と削除証明 SLA を承認する',
    fallbackWhenPending: '生フレームの長期保持・過去セルの再構築・旧データ統計畳み込み・pv_archive が実行不可',
    blockedCapabilities: ['r2_raw_frame_system_of_record', 'historical_cell_rederivation', 'published_retention_grid', 'pv_archive_long_lived_tier'],
  },
  {
    id: 'D-15',
    number: 15,
    category: 'prior_revision',
    title: 'D-05 改定: 料金体系への OEM アドオン追加（再販条項・DPA 連鎖・超過請求・前払パック）',
    owningArea: 'surf',
    specRef: '§11.8 / §14.2 #15',
    priorDecisionRef: 'SSOT D-05',
    consistencyOrderIds: ['O-32'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: true,
    legalSignedOff: false,
    deadlineStep: 'Q-29 前',
    recommendedOption: '上位プランアドオンとして再販条項・DPA 連鎖・開示受領者を法務署名し、30日突合後に超過請求を開始する',
    fallbackWhenPending: 'OEM キー (`ugk_oem_*`)・子テナント発行 API・前払クレジットパックは not_entitled',
    blockedCapabilities: ['oem_partner_keys', 'oem_sub_tenant_provisioning', 'prepaid_credit_packs', 'overage_invoicing'],
  },
  {
    id: 'D-16',
    number: 16,
    category: 'prior_revision',
    title: 'head 操作の線引き（構造化データ/llms.txt 生成・canonical/robots 操作・検索効果幅出力）',
    owningArea: 'del',
    specRef: '§10.8 / §14.2 #16',
    priorDecisionRef: 'S12:211 / E-5',
    consistencyOrderIds: ['O-24'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: false,
    legalSignedOff: false,
    deadlineStep: 'Q-23 前',
    recommendedOption: 'title/meta/見出しは先行実施しつつ、(i) 構造化データ・llms.txt と (ii) canonical/robots は個別承認、(iii) 検索効果の幅出力は改定承認する',
    fallbackWhenPending: 'SetCanonical / SetRobots / PutJsonLd / llms.txt 生成は not_entitled、検索変更効果は 4 段階確信度のみ',
    blockedCapabilities: ['origin_op_put_json_ld', 'origin_op_llms_txt_gen', 'origin_op_set_canonical', 'origin_op_set_robots', 'search_effect_interval_output'],
  },
  {
    id: 'D-17',
    number: 17,
    category: 'prior_revision',
    title: 'リアルタイム個別最適化の法務項目 (L11) 解消と AI 生成文表示規則 (F-4)',
    owningArea: 'tel',
    specRef: '§10.10 / §14.2 #17',
    priorDecisionRef: 'L11 / F-4',
    consistencyOrderIds: ['O-21', 'O-25'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: true,
    legalSignedOff: false,
    deadlineStep: 'Q-19 / Q-24 / Q-25 / Q-29 前',
    recommendedOption: '外部テナント向け履歴利用・個別最適化・input/ask 付与前に L11 を解消し、生成文のラベル表示規則を定める',
    fallbackWhenPending: '外部テナントでの履歴ベース推薦・個別最適化・生成コピー配信・input/ask 許可は not_entitled',
    blockedCapabilities: ['external_tenant_personalisation', 'cross_pv_history_features', 'generated_checked_copy_publishing', 'a3_input_ask_external'],
  },

  // ===== §14.3 新しい承認（18〜31） =====
  {
    id: 'D-18',
    number: 18,
    category: 'new_approval',
    title: '有償人間パネル（1,300 人以上）と同意文の承認',
    owningArea: 'act',
    specRef: '§7.5 / §14.3 #18',
    consistencyOrderIds: ['O-23'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: true,
    legalSignedOff: false,
    deadlineStep: 'Q-22 前',
    recommendedOption: '支援技術・入力方式コホートを含む 1,300 人以上の有償パネルと同意文を承認する',
    fallbackWhenPending: 'ローカル AI スコアに誤検知上限証明書を付けられず、inferred の社内利用止まり',
    blockedCapabilities: ['certified_local_agent_fpr_bound', 'touch_stratum_agent_score', 'no_script_precision_gate'],
  },
  {
    id: 'D-19',
    number: 19,
    category: 'new_approval',
    title: '外部学習計算基盤（Cloud Run Jobs / Modal GPU）と委託先一覧追加',
    owningArea: 'ml',
    specRef: '§8.10 / §8.14 / §14.3 #19',
    consistencyOrderIds: ['O-18'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: true,
    legalSignedOff: false,
    deadlineStep: 'Q-17 前',
    recommendedOption: 'CPU/GPU 学習コンテナ基盤を承認し、サブプロセッサ一覧と保存地域目録へ記載する',
    fallbackWhenPending: '自社インフラ外での学習ジョブ・挑戦者モデル学習・GPU 追加学習が実行不可',
    blockedCapabilities: ['external_ml_training_compute', 'challenger_gpu_training', 'resampling_compute_plane'],
  },
  {
    id: 'D-20',
    number: 20,
    category: 'new_approval',
    title: '状態を持たない訪問 (stateless_policy) の抽選既定',
    owningArea: 'del',
    specRef: '§10.6 / §14.3 #20',
    consistencyOrderIds: ['O-20'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: false,
    legalSignedOff: false,
    deadlineStep: 'Q-19 前',
    recommendedOption: 'indexable_minor 変更では既定を randomise（URL×日単位で統一応答）とする',
    fallbackWhenPending: '状態無し訪問をすべて対照に固定するため、見える閲覧の 60〜85% を実験から失い判定日数が数倍に延びる',
    blockedCapabilities: ['lane_v_stateless_randomisation'],
  },
  {
    id: 'D-21',
    number: 21,
    category: 'new_approval',
    title: 'v1 プロトコル定数初期値と自律運用のリスク目標の承認',
    owningArea: 'ev',
    specRef: '§9.4 / §12.2 / §14.3 #21',
    consistencyOrderIds: ['O-22', 'O-27'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: false,
    legalSignedOff: false,
    deadlineStep: 'Q-20 / Q-26 前',
    recommendedOption: '設計書の v1 定数初期値（事前SD 0.05/0.10/0.20、α配分、最短14日、8/26週、取り置き5%、有効180日、自律巻戻率5%=59回無事故）を採択する',
    fallbackWhenPending: '初期定数ロック未完了として事前登録ロック・自律本採用リスク上限が確定しない（設計書推奨値で構築しゲート待機）',
    blockedCapabilities: ['v1_protocol_constants_signoff', 'autonomous_promotion_risk_target'],
  },
  {
    id: 'D-22',
    number: 22,
    category: 'new_approval',
    title: '運用周期（月次リリース定期便・90日鍵ローテーション）と 2 人目のオフライン署名鍵担当者',
    owningArea: 'del',
    specRef: '§4.2 / §17.2 / §14.3 #22',
    consistencyOrderIds: [],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: false,
    legalSignedOff: false,
    deadlineStep: 'Q-6 / 本番運用開始前',
    recommendedOption: '月 1 回の定期リリース便、90 日鍵ローテーション、14 日毎の再署名、2 人目の鍵担当者を指名する',
    fallbackWhenPending: '単一担当者不在時にリリース一覧が 30 日期限切れとなり全配信が停止するリスクが残る',
    blockedCapabilities: ['dual_custodian_offline_signing_ops'],
  },
  {
    id: 'D-23',
    number: 23,
    category: 'new_approval',
    title: 'テナント横断持ち寄り同意規則の改定（公開登録簿・合計値の統計該当性法務確認）',
    owningArea: 'ev',
    specRef: '§8.7 / §9.7 / §14.3 #23',
    consistencyOrderIds: ['O-29'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: true,
    legalSignedOff: false,
    deadlineStep: 'Q-27 / Q-29 前',
    recommendedOption: '§8.7 の公開登録簿（5テナント/10テナント、重み上限 1/3、k≥50）を採用し、ヒストグラム合計の統計該当性を法務確認する',
    fallbackWhenPending: 'テナントをまたぐ実験統計公開 (ev.G-10) と連合学習 (ml.X1) は not_entitled',
    blockedCapabilities: ['cross_tenant_experiment_release', 'federated_histogram_learning_x1'],
  },
  {
    id: 'D-24',
    number: 24,
    category: 'new_approval',
    title: '計測データの顧客側引き渡し 3 段階（写し書き出し・顧客側正本配置の法務確認）',
    owningArea: 'store',
    specRef: '§5.12 / §14.3 #24',
    consistencyOrderIds: [],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: true,
    legalSignedOff: false,
    deadlineStep: 'Q-12 / 外部商用前',
    recommendedOption: '段 2（倉庫・Parquet 写し書き出し）を全プラン提供、段 3（顧客側正本）は自社検証と法務確認後に提供',
    fallbackWhenPending: '顧客は API 経由でのみデータ取得可能（倉庫同期・BYO ストレージ正本は not_entitled）',
    blockedCapabilities: ['customer_warehouse_export_tier2', 'customer_hosted_system_of_record_tier3'],
  },
  {
    id: 'D-25',
    number: 25,
    category: 'new_approval',
    title: '物販 EC 向け推薦のデータ受領・会員購入履歴利用・保持期間・売り切れ露出目標',
    owningArea: 'ml',
    specRef: '§8.13 / §14.3 #25',
    consistencyOrderIds: ['O-26'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: true,
    legalSignedOff: false,
    deadlineStep: 'Q-14 / Q-25 前',
    recommendedOption: '(i) 注文明細・粗利受領と (iv) 売り切れ露出上限を先行承認し、(ii) 会員履歴合流・(iii) 13 か月超保持は法務確認後に承認する',
    fallbackWhenPending: '合わせ買い・再購入学習とログイン会員履歴推薦は not_entitled（未ログイン相当のその場行動推薦のみ）',
    blockedCapabilities: ['ec_order_basket_repurchase_learning', 'ec_member_history_recommendations', 'ec_extended_order_retention'],
  },
  {
    id: 'D-26',
    number: 26,
    category: 'new_approval',
    title: '画面つき再生（リプレイ階層 3）を同意付き別車線として追加（録画禁止・H-5 の車線限定改定）',
    owningArea: 'tel',
    specRef: '§4.6 / §11.11 #8 / §14.3 #26',
    priorDecisionRef: 'SSOT D-11 / H-5（階層 3 車線限定改定）',
    consistencyOrderIds: [],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: true,
    legalSignedOff: false,
    deadlineStep: '再生試験収集開始前 / Q-19 以降',
    recommendedOption: '既定全マスク・隔離再生枠・30日保持・漏れ0ゲート・学習不使用を条件に正式決定番号と法務署名を取得する',
    fallbackWhenPending: '画面つき再生（階層 3）は not_entitled（文字なし階層 0〜2 のみ）',
    blockedCapabilities: ['dom_visual_replay_tier3_web', 'visual_replay_tier3_mobile'],
    notes: '2026-11-19〜20 にオーナーより「競合と同水準にする」方針表明済（Handoff §4）。正式な決定記録と法務確認が残存しているため pending。',
  },
  {
    id: 'D-27',
    number: 27,
    category: 'new_approval',
    title: '基礎機能の従量料金・無料枠目標と Segment 互換口・顧客定義イベントの受入承認',
    owningArea: 'surf',
    specRef: '§11.11 #2・#3・#7 / §14.3 #27',
    consistencyOrderIds: [],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: true,
    legalSignedOff: false,
    deadlineStep: 'Q-8 互換口有効化前 / Q-12 課金公開前',
    recommendedOption: '月200万イベント・再生5万本相当の無料枠目標と原価近傍従量、および顧客管理者責任を明記した Segment 互換・カスタムイベント受入を承認する',
    fallbackWhenPending: 'Segment 互換口・顧客定義イベント・公開無料枠料金表は not_entitled',
    blockedCapabilities: ['segment_compatible_ingest', 'customer_defined_events_lane', 'public_free_tier_pricing'],
  },
  {
    id: 'D-28',
    number: 28,
    category: 'new_approval',
    title: 'ソース公開の範囲（SDK・受付・契約・URLキー・区切り・送り先・マスク部品）とライセンス',
    owningArea: 'surf',
    specRef: '§11.11 #12 / §14.3 #28',
    consistencyOrderIds: [],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: true,
    legalSignedOff: false,
    deadlineStep: '既知弱点全修正後 / 波 7-D 前',
    recommendedOption: '公開可能ディレクトリ（packages/・受付・隠し方部品）と非公開資産（モデル・ボット規則・鍵）を分離し、ライセンスを法務確認して公開する',
    fallbackWhenPending: 'ソース公開は実施せず非公開リポジトリのまま維持',
    blockedCapabilities: ['open_source_core_release'],
  },
  {
    id: 'D-29',
    number: 29,
    category: 'new_approval',
    title: 'データ保存地域（最初の地域＝日本・地域保証可能な保存先選定・第2地域計画）',
    owningArea: 'store',
    specRef: '§11.11 #13 / §14.3 #29',
    consistencyOrderIds: ['O-33'],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: true,
    legalSignedOff: false,
    deadlineStep: 'Q-4 前（保存先構築前・最優先）',
    recommendedOption: '最初の保存地域を日本とし、契約上日本保存を保証できる保存先を選定・所在監査ゲート (surf.residency_audit) で担保する',
    fallbackWhenPending: '地域固定保存の顧客保証を行えず、金融・医療・公共等の地域要件案件へ提供不可',
    blockedCapabilities: ['japan_data_residency_guarantee', 'multi_region_eu_us_deployment'],
  },
  {
    id: 'D-30',
    number: 30,
    category: 'new_approval',
    title: '委託先ツールおよび独立第三者（広告媒体・メール配信等）への個人単位データ送信許可',
    owningArea: 'surf',
    specRef: '§11.11 #4・#10 / §14.3 #30',
    priorDecisionRef: '§11.3 / §12.3 外部書き出し k=10 伏せ規則の承認済み例外',
    consistencyOrderIds: [],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: true,
    legalSignedOff: false,
    deadlineStep: 'Q-12 外部送り先有効化前',
    recommendedOption: '同意目的・項目登録・契約/開示記載・削除通知を条件に委託先および第三者への直接送り先を承認済み例外として台帳登録する',
    fallbackWhenPending: '直接の送り先は顧客自身のデータ倉庫・自社ストリームのみに限定され、広告・メール媒体への個人単位送信は not_entitled',
    blockedCapabilities: ['processor_destination_individual_sync', 'third_party_ad_email_destination_sync'],
  },

  // ===== §14.3 #31（2026-11-20 オーナー決定反映: 31-a / 31-b / 31-c 決定済、31-d 未決定） =====
  {
    id: 'D-31a',
    number: 31,
    subId: 'a',
    category: 'new_approval',
    title: '生成モデルの基盤モデル選定方針（Muse Glimmer 30B vs Gemma 4 自前評価比較・両対応）',
    owningArea: 'ml',
    specRef: '§8.12 / §8.14 / §14.3 #31(a) / Handoff §4',
    consistencyOrderIds: [],
    status: 'decided',
    outcome: 'approved',
    decidedAt: '2026-11-20',
    legalSignOffRequired: false,
    legalSignedOff: false,
    deadlineStep: 'Q-17（Wave 4-G）',
    recommendedOption: 'Muse Glimmer 30B と Gemma 4 を自前日本語評価束およびライセンス条件で比較選定し、選定完了まで両モデルで動作する薄い推論層で実装する',
    fallbackWhenPending: '—（決定済）',
    blockedCapabilities: ['generative_model_dual_adapter_layer'],
    notes: '2026-11-20 オーナー決定済。最終配布前のライセンス本文確認は法務タスクとして継続。',
  },
  {
    id: 'D-31b',
    number: 31,
    subId: 'b',
    category: 'new_approval',
    title: 'Jev の出力の学習利用禁止（顧客データ・自社サイトデータともに恒久禁止）',
    owningArea: 'ml',
    specRef: '§8.14 / §14.3 #31(b) / Handoff §4',
    consistencyOrderIds: [],
    status: 'decided',
    outcome: 'prohibited',
    decidedAt: '2026-11-20',
    legalSignOffRequired: false,
    legalSignedOff: false,
    deadlineStep: '恒久適用（Wave 4-G / 4-H）',
    recommendedOption: 'Jev 利用規約（TypeSafe 基本契約 2.3(b) 蒸留・模倣学習禁止）および 2026-11-20 オーナー決定に従い、Jev 出力を学習正解・蒸留教師に使用しない。提供元への許可依頼も行わず、学習経路自体を構築しない。',
    fallbackWhenPending: '—（禁止として確定済。常に not_entitled / prohibited_by_decision を返す）',
    blockedCapabilities: ['jev_output_as_training_label', 'jev_output_distillation_teacher'],
    notes: '2026-11-20 オーナー確定決定: 顧客データ・自社データとも禁止。人のラベルと無作為実験結果のみを正解とする。',
  },
  {
    id: 'D-31c',
    number: 31,
    subId: 'c',
    category: 'new_approval',
    title: '生成モデル本番推論用計算基盤の承認',
    owningArea: 'ml',
    specRef: '§8.14 / §14.3 #31(d) / Handoff §4 / OWNER_TODO 31-c',
    consistencyOrderIds: [],
    status: 'decided',
    outcome: 'approved',
    decidedAt: '2026-11-20',
    legalSignOffRequired: false,
    legalSignedOff: false,
    deadlineStep: 'Q-17（Wave 4-G）',
    recommendedOption: '30B 級生成モデルの本番推論計算基盤（挑戦者用 GPU と別枠）を承認する',
    fallbackWhenPending: '—（決定済。外部計算基盤契約・API キー投入は OWNER_TODO §3）',
    blockedCapabilities: ['generative_model_production_inference_compute'],
    notes: '設計書 §14.3 では条項 (d) に該当。OWNER_TODO.md および実装計画の呼称 31-c に統一し、specRef に双方を記載。',
  },
  {
    id: 'D-31d',
    number: 31,
    subId: 'd',
    category: 'new_approval',
    title: 'テナント公開ページ文を全テナント共通追加部品の学習に使う条件',
    owningArea: 'ml',
    specRef: '§8.14 / §14.3 #31(c) / OWNER_TODO 31-d',
    consistencyOrderIds: [],
    status: 'pending',
    outcome: 'undecided',
    decidedAt: null,
    legalSignOffRequired: true,
    legalSignedOff: false,
    deadlineStep: 'Wave 4-H 共同学習開始前',
    recommendedOption: '自社サイトと明示オプトインしたテナントのみを対象とし、最小参加数・単一管理主体重み上限 1/3・離脱時24h除外/14日証明を §8.7 台帳へ追加する',
    fallbackWhenPending: '共通部品の追加学習には自社サイトの公開ページ文のみを使用し、外部テナント文の共通学習組み込みは not_entitled',
    blockedCapabilities: ['shared_adapter_cross_tenant_page_text_training'],
    notes: '設計書 §14.3 では条項 (c) に該当。OWNER_TODO.md の呼称 31-d に統一。',
  },
] as const

const DECISION_MAP = new Map<DecisionId, OwnerDecision>(
  DECISIONS_LEDGER.map((entry) => [entry.id, entry]),
)

/**
 * Normalize shorthand aliases such as `'31-b'`, `'31b'`, `'1'`, `'D-1'` into canonical `DecisionId`.
 */
export function normalizeDecisionId(rawId: string): DecisionId | null {
  const trimmed = rawId.trim()
  if (DECISION_MAP.has(trimmed as DecisionId)) {
    return trimmed as DecisionId
  }

  // Match patterns like "31-a", "31a", "D-31-a", "d-31a", "1", "01", "D-1"
  const subMatch = trimmed.match(/^(?:D-)?(\d{1,2})-?([a-d])$/i)
  if (subMatch) {
    const num = Number(subMatch[1])
    const sub = subMatch[2].toLowerCase()
    const padded = String(num).padStart(2, '0')
    const candidate = `D-${padded}${sub}` as DecisionId
    return DECISION_MAP.has(candidate) ? candidate : null
  }

  const numMatch = trimmed.match(/^(?:D-)?(\d{1,2})$/i)
  if (numMatch) {
    const num = Number(numMatch[1])
    const padded = String(num).padStart(2, '0')
    const candidate = `D-${padded}` as DecisionId
    return DECISION_MAP.has(candidate) ? candidate : null
  }

  return null
}

/**
 * Look up an owner decision by canonical id (`D-01`, `D-31b`) or shorthand alias (`31-b`).
 */
export function getDecision(decisionId: string): OwnerDecision | undefined {
  const normalized = normalizeDecisionId(decisionId)
  if (!normalized) return undefined
  return DECISION_MAP.get(normalized)
}

export interface RequireDecisionOptions {
  /** When true, also require `legalSignedOff === true` if `legalSignOffRequired` is set on the decision. */
  readonly enforceLegalSignOff?: boolean
}

/**
 * Guard function implementing Master Architecture v2 §1.2 / §14 and Implementation Plan §4:
 *   - Pending decisions return `{ entitled: false, status: 'not_entitled', reason: 'decision_pending' }`.
 *   - Explicitly prohibited decisions (such as `D-31b`: Jev training ban) return
 *     `{ entitled: false, status: 'not_entitled', reason: 'prohibited_by_decision' }`.
 *   - Approved decisions return `{ entitled: true, status: 'ok' }` (unless legal sign-off is required and missing).
 */
export function requireDecisionEntitled(
  decisionId: string,
  options: RequireDecisionOptions = {},
): DecisionEntitlementResult {
  const entry = getDecision(decisionId)
  if (!entry) {
    return {
      entitled: false,
      status: 'not_entitled',
      decisionId,
      reason: 'unknown_decision',
      message: `Unknown owner decision id "${decisionId}". Fail-closed as not_entitled.`,
      unlockRequirement: `Register decision "${decisionId}" in packages/contract/ledgers/decisions.ts and obtain explicit owner approval.`,
    }
  }

  if (entry.status === 'decided' && entry.outcome === 'prohibited') {
    return {
      entitled: false,
      status: 'not_entitled',
      decisionId: entry.id,
      reason: 'prohibited_by_decision',
      message: `Decision ${entry.id} (${entry.title}) was explicitly decided as PROHIBITED on ${entry.decidedAt ?? 'recorded date'}. Capability is permanently locked.`,
      unlockRequirement: `Permanently prohibited by owner decision ${entry.id} (${entry.decidedAt ?? 'recorded'}). Do not implement or enable this path.`,
    }
  }

  if (entry.status !== 'decided' || entry.outcome !== 'approved') {
    return {
      entitled: false,
      status: 'not_entitled',
      decisionId: entry.id,
      reason: 'decision_pending',
      message: `Owner decision ${entry.id} (${entry.title}) is pending. Feature stays closed as not_entitled.`,
      unlockRequirement: `Record owner decision ${entry.id} (deadline: ${entry.deadlineStep})${entry.legalSignOffRequired ? ' and obtain legal sign-off' : ''}.`,
    }
  }

  if (options.enforceLegalSignOff && entry.legalSignOffRequired && !entry.legalSignedOff) {
    return {
      entitled: false,
      status: 'not_entitled',
      decisionId: entry.id,
      reason: 'legal_signoff_pending',
      message: `Owner decision ${entry.id} is approved, but required legal sign-off is not yet recorded.`,
      unlockRequirement: `Record legal sign-off for decision ${entry.id}.`,
    }
  }

  return {
    entitled: true,
    status: 'ok',
    decisionId: entry.id,
    outcome: 'approved',
    decidedAt: entry.decidedAt ?? '',
  }
}

/**
 * Throwing assertion wrapper around `requireDecisionEntitled`.
 */
export function assertDecisionEntitled(
  decisionId: string,
  options: RequireDecisionOptions = {},
): Extract<DecisionEntitlementResult, { entitled: true }> {
  const result = requireDecisionEntitled(decisionId, options)
  if (!result.entitled) {
    throw new NotEntitledError(result)
  }
  return result
}
