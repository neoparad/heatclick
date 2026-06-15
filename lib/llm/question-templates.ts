/**
 * lib/llm/question-templates.ts — Question Templates (続 68 W2-A、続 66 §3 M-3)
 *
 * 親 SSOT §1.6 原則 2 / D-07
 * 配備根拠: 続 66 §2 Layer 1 #3 (定型質問 < 1 秒応答 = 80% 質問を template hit で高速化)
 *
 * 規格:
 *   - 1 template = { id, intent, examples, toolPlan, answerSkeleton, evidenceLevel, estimatedLatencyMs }
 *   - examples = 日本語自然文 3-5 件 (classifier の RAG seed、W2-B で embedding 化)
 *   - toolPlan = `analytics.overview(7d, [cvr])` 等の DSL 文字列、orchestrator が parse して実行
 *   - answerSkeleton = `{value}` 等の placeholder を含む応答テンプレ、tool result で埋める
 *
 * 続 81 Director hot fix (Owner 2026-05-25 報告対応):
 *   旧版は全 answerSkeleton に「推定」prefix を hard-code していたため、
 *   observed_approx (誤差 〜2%) でも「推定」と表示され、Owner から
 *   「実測 vs 推定の区別が付かない」「クライアントに説明できない」とフィードバック。
 *
 *   修正方針:
 *     - "推定" を hard-code しない (orchestrator が evidenceLevel に応じて prefix を動的付与)
 *     - inferred/planned 時のみ chat-reply-validator が "推定" prefix を auto-add
 *     - observed_exact (raw 直接 query) / observed_approx (MV merge) は prefix なし
 *     - 文末に近似集計の注釈 (例: "(近似集計、〜2%誤差)") を別途追加可
 *
 * W2-A scope:
 *   - 15 件配備 (主要 metric × dim × intent 組合せの代表)
 *   - rule-based classifier (`classifyQuestion()`) で keyword match + 部分文字列 score
 *   - Confidence < 0.6 → orchestrator が Haiku classifier に fallback (M-4)
 *
 * W2-B 拡張 (続 66 §3 M-11、別 dispatch):
 *   - 残 35 件追加 → 計 50 件
 *   - OpenAI embeddings (`text-embedding-3-small`) で semantic match
 *   - cosine similarity > 0.85 で hit
 */

import type { EvidenceLevelV2 } from '@/types/evidence'

export interface QuestionTemplate {
  /** Stable ID (audit ledger / template hit 計測用) */
  id: string
  /** Intent label (人間向け説明) */
  intent: string
  /** Classifier 用 example queries (日本語、3-5 件推奨) */
  examples: string[]
  /** Tool execution plan (DSL、orchestrator がパース実行) */
  toolPlan: string[]
  /** Reply skeleton (`{value}` placeholder を tool result で埋める) */
  answerSkeleton: string
  /** Expected evidence level (5-tier V2) */
  evidenceLevel: EvidenceLevelV2
  /** ms (UI hint、実測は audit ledger で観測) */
  estimatedLatencyMs: number
  /** Category for analytics + UI grouping */
  category: 'metric_baseline' | 'metric_breakdown' | 'anomaly' | 'comparison' | 'guidance'
}

// ── Templates (W2-A: 15 件配備) ─────────────────────────────────────

export const QUESTION_TEMPLATES: ReadonlyArray<QuestionTemplate> = [
  // ── Category: metric_baseline (5 件) ─────────────────────────────
  {
    id: 'CVR_WEEKLY',
    intent: 'CVR の週次サマリ',
    examples: [
      '先週の CVR は?',
      '過去 7 日の CV 率',
      'コンバージョン率の動き',
      '今週の CV を教えて',
    ],
    toolPlan: ['analytics.overview(7d, [cvr, sessions])'],
    answerSkeleton: 'CVR は {cvr_pct}% で、セッション数は {sessions} 件です。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 1500,
    category: 'metric_baseline',
  },
  {
    id: 'CVR_MONTHLY',
    intent: 'CVR の月次サマリ',
    examples: ['今月の CVR', '過去 30 日の CV 率', '月次コンバージョン'],
    toolPlan: ['analytics.overview(30d, [cvr, sessions])'],
    answerSkeleton: '直近 30 日 CVR は {cvr_pct}% (セッション {sessions} 件)。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 1800,
    category: 'metric_baseline',
  },
  {
    id: 'SESSIONS_WEEKLY',
    intent: 'セッション数 週次',
    examples: ['先週のセッション数', '週次トラフィック', '訪問数を教えて'],
    toolPlan: ['analytics.overview(7d, [sessions, page_views])'],
    answerSkeleton: '{sessions} セッション / {page_views} ページビューでした。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 1200,
    category: 'metric_baseline',
  },
  {
    id: 'BOUNCE_WEEKLY',
    intent: '離脱率 週次',
    examples: ['先週の離脱率', 'バウンスレート', 'すぐ帰る人の割合'],
    toolPlan: ['analytics.overview(7d, [cvr, sessions])'],
    answerSkeleton: '直近 7 日の離脱率は {bounce_pct}%。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 1300,
    category: 'metric_baseline',
  },
  {
    id: 'DURATION_WEEKLY',
    intent: '滞在時間 週次',
    examples: ['平均滞在時間', '直近の滞在', 'セッション時間'],
    toolPlan: ['analytics.overview(7d, [page_views])'],
    answerSkeleton: '平均滞在時間 {duration_sec}秒 (中央値、TDigest 近似)。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 1400,
    category: 'metric_baseline',
  },

  // ── Category: metric_breakdown (4 件、parent → contributors) ────
  {
    id: 'BOUNCE_PAGES',
    intent: '離脱率が高いページ',
    examples: ['離脱多いページ', 'バウンスレート高いところ', 'すぐ帰っちゃうページ'],
    toolPlan: [
      'analytics.overview(7d, [cvr, sessions])',
      'analytics.contributors(page_url, dimension=page_url, limit=10) [parentQueryId]',
    ],
    answerSkeleton: '離脱率が高いのは {top_3_pages}。詳しく見ますか?',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 2500,
    category: 'metric_breakdown',
  },
  {
    id: 'CVR_BY_DEVICE',
    intent: 'デバイス別 CVR',
    examples: ['デバイス別の CV', 'モバイル / PC の差', 'スマホと PC で CVR どっちが高い'],
    toolPlan: [
      'analytics.overview(7d, [cvr, sessions])',
      'analytics.contributors(dimension=device, limit=5) [parentQueryId]',
    ],
    answerSkeleton: 'デバイス別 CVR は {device_breakdown}。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 2300,
    category: 'metric_breakdown',
  },
  {
    id: 'TOP_PAGES_BY_SESSIONS',
    intent: 'トラフィック上位ページ',
    examples: ['人気ページ', 'アクセス多いページ', 'よく見られてるページ'],
    toolPlan: [
      'analytics.overview(7d, [sessions, page_views])',
      'analytics.contributors(dimension=page_url, limit=10) [parentQueryId]',
    ],
    answerSkeleton: '上位ページ: {top_10_pages}。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 2400,
    category: 'metric_breakdown',
  },
  {
    id: 'PERSONA_CVR',
    intent: 'ペルソナ別 CVR',
    examples: ['ペルソナ別 CV', 'どの persona の CVR が高い', 'persona ごとの違い'],
    toolPlan: [
      'analytics.overview(14d, [cvr, sessions])',
      'analytics.contributors(dimension=device, limit=5) [parentQueryId]',
    ],
    answerSkeleton: 'ペルソナ別 CVR: {persona_breakdown}。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 2600,
    category: 'metric_breakdown',
  },

  // ── Category: anomaly (3 件、parent → contributors → drilldown) ─
  {
    id: 'CVR_DROP_ROOT_CAUSE',
    intent: 'CVR 下落の原因',
    examples: ['CVR が下がった原因', 'なぜ CV 減ったの', '昨日からの落ち込み', 'CVR 急落'],
    toolPlan: [
      'analytics.overview(14d, [cvr, sessions, cvr])',
      'analytics.contributors(dimension=page_url, limit=10) [parentQueryId]',
      'analytics.drilldown(dimension=page_url, value=top_loser, grain=day) [parentQueryId]',
    ],
    answerSkeleton: '主要因は {page} (寄与 {pct}%) で、{reason}。verify ツールで再計算しますか?',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 4000,
    category: 'anomaly',
  },
  {
    id: 'BOUNCE_SPIKE',
    intent: '離脱率の急上昇',
    examples: ['離脱率が上がった', 'バウンス急増', '直近で離脱多い'],
    toolPlan: [
      'analytics.overview(14d, [cvr])',
      'analytics.drilldown(dimension=page_url, value=top_offender, grain=hour) [parentQueryId]',
    ],
    answerSkeleton: '離脱率スパイクは {timestamp} 周辺、ページ {page} で観測。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 3500,
    category: 'anomaly',
  },
  {
    id: 'TRAFFIC_DROP',
    intent: 'トラフィック減少',
    examples: ['アクセス減ってる', 'トラフィック下がった', 'セッション減少'],
    toolPlan: [
      'analytics.overview(14d, [sessions, page_views])',
      'analytics.contributors(dimension=page_url, limit=10) [parentQueryId]',
    ],
    answerSkeleton: 'トラフィック減少の主要因: {top_drop_pages}。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 3000,
    category: 'anomaly',
  },

  // ── Category: comparison (2 件、parent × 2) ─────────────────────
  {
    id: 'WOW_COMPARISON',
    intent: '前週との比較',
    examples: ['先週との比較', '前週比', '今週 vs 先週'],
    toolPlan: [
      'analytics.overview(7d, [cvr, sessions, cvr])',
      'analytics.overview(14d-7d, [cvr, sessions, cvr])',
    ],
    answerSkeleton: '今週: CVR {now_cvr}% / 先週: CVR {prev_cvr}% (差分 {delta}%)',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 3200,
    category: 'comparison',
  },
  {
    id: 'MOM_COMPARISON',
    intent: '前月との比較',
    examples: ['先月との比較', '月次比較', '前月比', '月初比'],
    toolPlan: [
      'analytics.overview(30d, [cvr, sessions])',
      'analytics.overview(60d-30d, [cvr, sessions])',
    ],
    answerSkeleton: '今月: CVR {now_cvr}% / 先月: CVR {prev_cvr}% (差分 {delta}%)',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 3500,
    category: 'comparison',
  },

  // ============================================================================
  // 続 70 拡張: 35 件追加 (Director 続 66 §3 M-3 目標 50 件達成)
  // 配分: metric_baseline +5 / metric_breakdown +9 / anomaly +7 / comparison +8 / guidance +6
  // ============================================================================

  // ── Category: metric_baseline (追加 5 件、計 10 件) ──────────────
  {
    id: 'CTR_WEEKLY',
    intent: 'CTA / リンク CTR 週次',
    examples: ['CTR は?', 'クリック率', 'ボタンの押下率', 'CTA 効率'],
    toolPlan: ['analytics.overview(7d, [page_views, sessions])'],
    answerSkeleton:
      'クリック率に近い指標として、セッションあたり {ratio} ページビュー (7 日)。' +
      '正確な CTR は CTA イベント tagging が必要です。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 1600,
    category: 'metric_baseline',
  },
  {
    id: 'PV_WEEKLY',
    intent: 'ページビュー数 週次',
    examples: ['先週の PV', 'ページビュー数', '閲覧数を教えて', 'PV 動向'],
    toolPlan: ['analytics.overview(7d, [page_views, sessions])'],
    answerSkeleton: '{page_views} PV / {sessions} セッション (7 日)。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 1200,
    category: 'metric_baseline',
  },
  {
    id: 'NEW_VS_REPEAT',
    intent: '新規 vs リピート',
    examples: ['新規ユーザー比率', 'リピート率', '初回訪問の割合'],
    toolPlan: ['analytics.overview(7d, [sessions])'],
    answerSkeleton:
      'セッション 全体 {sessions} 件。新規 / リピートの厳密分離は persona / 訪問頻度フラグが必要です。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 1400,
    category: 'metric_baseline',
  },
  {
    id: 'MOBILE_VS_PC',
    intent: 'モバイル vs PC 全体比率',
    examples: ['モバイルと PC の割合', 'デバイス比率', 'スマホ多い?'],
    toolPlan: [
      'analytics.overview(7d, [sessions])',
      'analytics.contributors(dimension=device, limit=5) [parentQueryId]',
    ],
    answerSkeleton: 'デバイス比率: {device_breakdown}。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 2200,
    category: 'metric_baseline',
  },
  {
    id: 'TRAFFIC_NOW',
    intent: '直近トラフィック',
    examples: ['今のアクセス', 'リアルタイム', '直近 24h'],
    toolPlan: ['analytics.overview(1d, [sessions, page_views])'],
    answerSkeleton: '過去 24h: {sessions} セッション / {page_views} PV (近似集計、誤差 〜2%)。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 1100,
    category: 'metric_baseline',
  },

  // ── Category: metric_breakdown (追加 9 件、計 13 件) ─────────────
  {
    id: 'CVR_BY_PAGE',
    intent: 'ページ別 CVR',
    examples: ['ページ別 CVR', 'どのページの CV が高い', 'CV の出るページ'],
    toolPlan: [
      'analytics.overview(14d, [cvr, sessions])',
      'analytics.contributors(dimension=page_url, limit=15) [parentQueryId]',
    ],
    answerSkeleton: 'CVR 上位ページ: {top_3_pages}。詳しく見ますか?',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 2500,
    category: 'metric_breakdown',
  },
  {
    id: 'BOUNCE_BY_DEVICE',
    intent: 'デバイス別 離脱率',
    examples: ['モバイルとPCの離脱率', 'デバイス別バウンス', '離脱多いデバイス'],
    toolPlan: [
      'analytics.overview(7d, [cvr, sessions])',
      'analytics.contributors(dimension=device, limit=5) [parentQueryId]',
    ],
    answerSkeleton: 'デバイス別離脱率: {device_breakdown}。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 2300,
    category: 'metric_breakdown',
  },
  {
    id: 'SESSIONS_BY_DEVICE',
    intent: 'デバイス別 セッション数',
    examples: ['デバイス別流入', 'モバイル流入', '端末別アクセス'],
    toolPlan: [
      'analytics.overview(7d, [sessions])',
      'analytics.contributors(dimension=device, limit=5) [parentQueryId]',
    ],
    answerSkeleton: 'デバイス別 セッション数: {device_breakdown}。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 2100,
    category: 'metric_breakdown',
  },
  {
    id: 'SESSIONS_BY_PERSONA',
    intent: 'ペルソナ別 セッション数',
    examples: ['persona 別流入', 'ペルソナ流入', 'どの persona が多い'],
    toolPlan: [
      'analytics.overview(14d, [sessions])',
      'analytics.contributors(dimension=device, limit=10) [parentQueryId]',
    ],
    answerSkeleton: 'ペルソナ別 セッション数: {persona_breakdown}。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 2400,
    category: 'metric_breakdown',
  },
  {
    id: 'DURATION_BY_PAGE',
    intent: 'ページ別 滞在時間',
    examples: ['ページ別滞在', '読まれてるページ', '滞在長いページ'],
    toolPlan: [
      'analytics.overview(7d, [page_views, sessions])',
      'analytics.contributors(dimension=page_url, limit=10) [parentQueryId]',
    ],
    answerSkeleton: '滞在時間上位ページ: {top_3_pages}。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 2700,
    category: 'metric_breakdown',
  },
  {
    id: 'BOUNCE_BY_PERSONA',
    intent: 'ペルソナ別 離脱率',
    examples: ['persona 別離脱', 'どの persona が帰る', 'ペルソナ × バウンス'],
    toolPlan: [
      'analytics.overview(14d, [cvr, sessions])',
      'analytics.contributors(dimension=device, limit=10) [parentQueryId]',
    ],
    answerSkeleton: 'ペルソナ別離脱率: {persona_breakdown}。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 2600,
    category: 'metric_breakdown',
  },
  {
    id: 'PV_BY_PAGE',
    intent: 'ページ別 PV',
    examples: ['ページ別 PV', '閲覧多いページ', 'よく読まれてる'],
    toolPlan: [
      'analytics.overview(7d, [page_views, sessions])',
      'analytics.contributors(dimension=page_url, limit=15) [parentQueryId]',
    ],
    answerSkeleton: 'PV 上位ページ: {top_3_pages}。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 2400,
    category: 'metric_breakdown',
  },
  {
    id: 'CV_TOP_CONTRIBUTORS',
    intent: 'CV 寄与上位',
    examples: ['CV 多い page', 'コンバージョン上位', '稼ぐページ'],
    toolPlan: [
      'analytics.overview(14d, [cvr, sessions])',
      'analytics.contributors(dimension=page_url, limit=15) [parentQueryId]',
    ],
    answerSkeleton: 'CV 寄与上位ページ: {top_3_pages} (累計 coverage 含む)。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 2800,
    category: 'metric_breakdown',
  },
  {
    id: 'BOUNCE_DRILLDOWN',
    intent: '特定ページの離脱詳細',
    examples: ['/pricing の離脱', '特定ページのバウンス', 'このページの離脱率'],
    toolPlan: [
      'analytics.overview(14d, [cvr, sessions])',
      'analytics.drilldown(dimension=page_url, value=specified, grain=day) [parentQueryId]',
    ],
    answerSkeleton: 'ページ別離脱率 (時系列): {drilldown_series}。anomaly: {anomalies}。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 3200,
    category: 'metric_breakdown',
  },

  // ── Category: anomaly (追加 7 件、計 10 件) ──────────────────────
  {
    id: 'CV_SURGE',
    intent: 'CV 急増の原因',
    examples: ['CV 急に増えた', 'コンバージョン 跳ねた', 'CV が伸びた要因'],
    toolPlan: [
      'analytics.overview(14d, [cvr, sessions])',
      'analytics.contributors(dimension=page_url, limit=10) [parentQueryId]',
      'analytics.drilldown(dimension=page_url, value=top_gainer, grain=hour) [parentQueryId]',
    ],
    answerSkeleton: 'CV 急増の主要因は {page} (寄与 {pct}%)、{reason}。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 4000,
    category: 'anomaly',
  },
  {
    id: 'DURATION_DROP',
    intent: '滞在時間 悪化',
    examples: ['滞在時間 短くなった', '読まれなくなった', '直近 滞在悪化'],
    toolPlan: [
      'analytics.overview(14d, [page_views, sessions])',
      'analytics.contributors(dimension=page_url, limit=10) [parentQueryId]',
    ],
    answerSkeleton: '滞在時間悪化の主要因: {top_drop_pages}。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 3300,
    category: 'anomaly',
  },
  {
    id: 'MOBILE_BOUNCE_SPIKE',
    intent: 'モバイル離脱の急増',
    examples: ['モバイル離脱増えた', 'スマホの離脱', 'mobile で帰る人増'],
    toolPlan: [
      'analytics.overview(14d, [cvr, sessions])',
      'analytics.drilldown(dimension=device, value=mobile, grain=hour) [parentQueryId]',
    ],
    answerSkeleton: 'モバイル離脱率 (時系列): {drilldown_series}、anomaly: {anomalies}。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 3600,
    category: 'anomaly',
  },
  {
    id: 'NEW_USER_DROP',
    intent: '新規ユーザー数 減少',
    examples: ['新規が減った', '初回訪問減った', '新規流入悪化'],
    toolPlan: [
      'analytics.overview(14d, [sessions])',
      'analytics.contributors(dimension=page_url, limit=10) [parentQueryId]',
    ],
    answerSkeleton: '新規 (相当) 減少の主要因: {top_drop_pages}。persona 流入詳細も確認推奨。',
    evidenceLevel: 'inferred',
    estimatedLatencyMs: 3500,
    category: 'anomaly',
  },
  {
    id: 'PAGE_EXIT_SPIKE',
    intent: '特定ページの離脱急増',
    examples: ['/checkout で離脱', '特定ページの離脱 急増', 'ここで止まる'],
    toolPlan: [
      'analytics.overview(14d, [cvr, sessions])',
      'analytics.drilldown(dimension=page_url, value=specified, grain=hour) [parentQueryId]',
      'analytics.verify(parentQueryId, metric=cvr, page) [parentQueryId]',
    ],
    answerSkeleton:
      '該当ページ離脱率 (時系列): {drilldown_series}。verify による exact: {verify}。',
    evidenceLevel: 'proven_exact',
    estimatedLatencyMs: 4500,
    category: 'anomaly',
  },
  {
    id: 'TRAFFIC_SURGE',
    intent: 'トラフィック急増',
    examples: ['アクセス急増', 'トラフィック跳ねた', '流入急に増えた'],
    toolPlan: [
      'analytics.overview(14d, [sessions, page_views])',
      'analytics.contributors(dimension=page_url, limit=10) [parentQueryId]',
    ],
    answerSkeleton: 'トラフィック急増の主要因: {top_gainer_pages}。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 3000,
    category: 'anomaly',
  },
  {
    id: 'WEEKDAY_PATTERN',
    intent: '曜日別パターン異常',
    examples: ['週末弱い', '平日減', '曜日トレンド'],
    toolPlan: [
      'analytics.overview(28d, [cvr, sessions])',
      'analytics.drilldown(dimension=page_url, value=all, grain=day) [parentQueryId]',
    ],
    answerSkeleton: '曜日別パターン: {drilldown_series}。anomaly: {anomalies}。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 3400,
    category: 'anomaly',
  },

  // ── Category: comparison (追加 8 件、計 10 件) ───────────────────
  {
    id: 'YOY_COMPARISON',
    intent: '昨年同期比',
    examples: ['YoY', '昨年同期比', '去年比'],
    toolPlan: [
      'analytics.overview(30d, [cvr, sessions])',
      'analytics.overview(365d-335d, [cvr, sessions])',
    ],
    answerSkeleton: '今月: CVR {now_cvr}% / 昨年同月: CVR {prev_cvr}% (差分 {delta}%)。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 4000,
    category: 'comparison',
  },
  {
    id: 'PERSONA_COMPARISON',
    intent: 'ペルソナ間比較',
    examples: ['persona A と B 比較', 'ペルソナごとの差', 'segment 比較'],
    toolPlan: [
      'analytics.overview(14d, [cvr, sessions])',
      'analytics.contributors(dimension=device, limit=5) [parentQueryId]',
    ],
    answerSkeleton: 'ペルソナ間比較: {persona_breakdown}。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 2800,
    category: 'comparison',
  },
  {
    id: 'DEVICE_COMPARISON',
    intent: 'デバイス間比較',
    examples: ['モバイル vs PC 比較', 'デバイス比較', '端末で違う?'],
    toolPlan: [
      'analytics.overview(7d, [cvr, cvr, sessions])',
      'analytics.contributors(dimension=device, limit=5) [parentQueryId]',
    ],
    answerSkeleton: 'デバイス比較: {device_breakdown}。差分 {device_delta}%。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 2700,
    category: 'comparison',
  },
  {
    id: 'PAGE_PAIR_COMPARISON',
    intent: 'ページ対比較',
    examples: ['A と B のページ比較', '2 ページ比較', 'どっちが CV 良い'],
    toolPlan: [
      'analytics.overview(14d, [cvr, sessions])',
      'analytics.drilldown(dimension=page_url, value=A, grain=day) [parentQueryId]',
      'analytics.drilldown(dimension=page_url, value=B, grain=day) [parentQueryId]',
    ],
    answerSkeleton: 'ページ A vs B: CVR {a_cvr}% vs {b_cvr}%。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 4200,
    category: 'comparison',
  },
  {
    id: 'PERSONA_DEVICE_MATRIX',
    intent: 'ペルソナ × デバイス',
    examples: ['persona × device', 'ペルソナごとのデバイス比率', 'cross 分析'],
    toolPlan: [
      'analytics.overview(14d, [cvr, sessions])',
      'analytics.contributors(dimension=device, limit=10) [parentQueryId]',
      'analytics.contributors(dimension=device, limit=5) [parentQueryId]',
    ],
    answerSkeleton:
      'persona × device cross 分析: {persona_breakdown} × {device_breakdown}。',
    evidenceLevel: 'inferred',
    estimatedLatencyMs: 4800,
    category: 'comparison',
  },
  {
    id: 'PRE_POST_COMPARISON',
    intent: '施策前後比較',
    examples: ['施策前後', 'リリース前後', '変更前と後'],
    toolPlan: [
      'analytics.overview(14d, [cvr, sessions, cvr])',
      'analytics.overview(28d-14d, [cvr, sessions, cvr])',
    ],
    answerSkeleton: '施策後: CVR {now_cvr}% / 施策前: CVR {prev_cvr}% (差分 {delta}%)。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 3600,
    category: 'comparison',
  },
  {
    id: 'BEST_VS_WORST_PAGE',
    intent: '上位 vs 下位ページ',
    examples: ['best vs worst', '上位下位ページ', '効果あるページとないページ'],
    toolPlan: [
      'analytics.overview(14d, [cvr, sessions])',
      'analytics.contributors(dimension=page_url, limit=20) [parentQueryId]',
    ],
    answerSkeleton: '上位: {top_3_pages} / 下位: {bottom_3_pages}。差分 {delta}%。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 3000,
    category: 'comparison',
  },
  {
    id: 'TIME_OF_DAY_COMPARISON',
    intent: '時間帯比較',
    examples: ['朝と夜の違い', '時間帯比較', '日中 vs 夜中'],
    toolPlan: [
      'analytics.overview(7d, [cvr, sessions])',
      'analytics.drilldown(dimension=page_url, value=all, grain=hour) [parentQueryId]',
    ],
    answerSkeleton: '時間帯別 CVR: {drilldown_series}。peak: {anomalies}。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 3500,
    category: 'comparison',
  },

  // ── Category: guidance (追加 6 件、計 7 件) ──────────────────────
  {
    id: 'GUIDANCE_TEMPLATES_LIST',
    intent: 'テンプレ一覧',
    examples: ['テンプレ一覧', '質問例', 'よくある質問', '聞ける質問'],
    toolPlan: [],
    answerSkeleton:
      '主な質問テンプレート: CVR 週次 / 離脱多いページ / CVR 下落の原因 / デバイス別 CVR / 前週との比較 など全 50 件。',
    evidenceLevel: 'planned',
    estimatedLatencyMs: 700,
    category: 'guidance',
  },
  {
    id: 'GUIDANCE_EVIDENCE_LEVELS',
    intent: 'Evidence Level 説明',
    examples: ['Evidence Level とは', '推定と確定の違い', 'バッジの意味'],
    toolPlan: [],
    answerSkeleton:
      'Evidence Level は 5 段階: proven_exact (raw 完全一致) / observed_exact (集計テーブル一致) / ' +
      'observed_approx (近似集計、誤差 〜2%) / inferred (LLM 推論) / planned (計画値)。' +
      'analytics.verify で proven_exact 化が可能です。',
    evidenceLevel: 'planned',
    estimatedLatencyMs: 600,
    category: 'guidance',
  },
  {
    id: 'GUIDANCE_VERIFY_TOOL',
    intent: 'verify ツール説明',
    examples: ['verify とは', '正確な数値', 'exact 再計算', '主張を裏取り'],
    toolPlan: [],
    answerSkeleton:
      'analytics.verify は主張する数値を raw events で exact 再計算し、tolerance ±2% で照合します。' +
      '一致時は evidence_level を proven_exact に格上げ。重要な意思決定の前に使用推奨。',
    evidenceLevel: 'planned',
    estimatedLatencyMs: 700,
    category: 'guidance',
  },
  {
    id: 'GUIDANCE_DRILLDOWN_TOOL',
    intent: 'drilldown ツール説明',
    examples: ['drilldown とは', '詳細分析', '時系列で見る', 'ページ別深掘り'],
    toolPlan: [],
    answerSkeleton:
      'analytics.drilldown は特定 dim_value (例: /pricing) の時系列詳細 + anomalies (z-score > 2.5) を返します。' +
      '原因深掘りに使用。先に analytics.overview で parentQueryId が必要です。',
    evidenceLevel: 'planned',
    estimatedLatencyMs: 700,
    category: 'guidance',
  },
  {
    id: 'GUIDANCE_RATE_LIMIT',
    intent: 'rate limit 説明',
    examples: ['上限', 'rate limit', 'なぜ拒否された?', '使いすぎ?'],
    toolPlan: [],
    answerSkeleton:
      'チャットは tenant あたり 60 req/h の上限があります (LLM コスト + abuse 防御)。' +
      '超過時は 429 で Retry-After ヘッダが返却されます。',
    evidenceLevel: 'planned',
    estimatedLatencyMs: 500,
    category: 'guidance',
  },
  {
    id: 'GUIDANCE_DATA_FRESHNESS',
    intent: 'データ鮮度',
    examples: ['データはいつまで', '集計遅延', 'リアルタイム?', 'いつのデータ?'],
    toolPlan: [],
    answerSkeleton:
      '直近 2 時間は raw events (リアルタイム)、それ以前は MV (集計済) を hybrid で結合します。' +
      'daily summary は毎日 02:00 JST (Vercel Cron) で更新。',
    evidenceLevel: 'planned',
    estimatedLatencyMs: 600,
    category: 'guidance',
  },

  // ============================================================================
  // 続 82-ml skeleton (2026-05-25): organic / visitor_type 3 template 配備
  //   - Infra 続 82 (sessions_hourly MV + events_hourly_by_dim v2 dim) 完了後に
  //     classifier hit から実 query 結果まで通る。
  //   - 現状 (skeleton phase) は orchestrator.detectUnsupportedConcepts() の
  //     UNSUPPORTED_KEYWORD_MAP が 'オーガニック'/'organic'/'即離脱'/'新規ユーザー'/'リピーター' を
  //     block するため、これら template は classifier 経路に進入しても入口で fail-fast。
  //   - Phase 2 で UNSUPPORTED_KEYWORD_MAP から bounce_metric / organic_segment /
  //     visitor_repeat の 3 category を削除した時点で本 template が活性化。
  // ============================================================================
  {
    id: 'ORGANIC_TRAFFIC_SHARE',
    intent: 'オーガニック流入比率',
    examples: [
      '昨日のオーガニックアクセス',
      'オーガニック流入の割合',
      '自然検索からの訪問',
      '流入元別の割合',
    ],
    toolPlan: [
      'analytics.overview(7d, [sessions])',
      'analytics.contributors(dimension=utm_source, limit=10) [parentQueryId]',
    ],
    answerSkeleton: '流入経路別 セッション数: {top_3_pages} (全 {sessions} セッション)。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 2500,
    category: 'metric_breakdown',
  },
  {
    id: 'ORGANIC_BOUNCE_RATE',
    intent: 'オーガニック流入の離脱率',
    examples: [
      'オーガニックの離脱率',
      '自然検索からの即離脱',
      '昨日のオーガニックで即離脱した割合',
    ],
    toolPlan: [
      'analytics.overview(1d, [bounce_rate, sessions], filter=utm_source=organic)',
    ],
    answerSkeleton:
      'オーガニック流入の離脱率は {bounce_pct}% (セッション {sessions} 件)。' +
      '※ session_end イベント未到達 session を除外。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 1500,
    category: 'metric_baseline',
  },
  {
    id: 'NEW_VS_RETURNING_CVR',
    intent: '新規 vs リピーター CVR',
    examples: ['新規とリピーターの CVR', '新規 vs 再訪', 'リピート率'],
    toolPlan: [
      'analytics.overview(7d, [cvr, sessions])',
      'analytics.contributors(dimension=visitor_type, limit=5) [parentQueryId]',
    ],
    answerSkeleton: '新規 vs リピーター CVR: {device_breakdown}。',
    evidenceLevel: 'observed_approx',
    estimatedLatencyMs: 2200,
    category: 'metric_breakdown',
  },

  // ── Category: guidance (既存 1 件、計 7 件) ─────────────────────
  {
    id: 'WHAT_CAN_YOU_DO',
    intent: '機能ガイダンス',
    examples: ['何ができる?', '使い方', 'どんな質問できる?', 'できること教えて'],
    toolPlan: [], // tool 呼出不要、daily summary + ガイダンス文のみ
    answerSkeleton:
      '直近のサイト状況の解説、CVR や離脱率の breakdown、原因深掘り、特定ページの時系列分析、' +
      '主張する数値の exact 再計算 (verify) などが可能です。例: 「CVR 下がった原因」「離脱多いページ」',
    evidenceLevel: 'planned',
    estimatedLatencyMs: 800,
    category: 'guidance',
  },
] as const

// ── Classifier (rule-based、W2-A 範囲) ───────────────────────────

export interface ClassificationResult {
  templateId: string | null
  confidence: number
  matched: ReadonlyArray<{ templateId: string; score: number }>
}

/**
 * Rule-based template classifier (keyword + 部分文字列 score)。
 *
 * Score:
 *   - example と完全一致 → 1.0
 *   - example が question に含まれる → 0.85
 *   - question が example に含まれる → 0.75
 *   - keyword (intent 単語) match → +0.15 per keyword (max +0.45)
 *
 * Threshold:
 *   - max score >= 0.75 → template hit
 *   - 0.6 <= max score < 0.75 → borderline (orchestrator が Haiku confirm)
 *   - < 0.6 → unknown (orchestrator が Haiku classifier に full delegation)
 *
 * W2-A は本実装で十分 (主要 15 template + 主流質問 80%)、W2-B で embedding 拡張。
 */
export function classifyQuestion(question: string): ClassificationResult {
  const normalized = normalize(question)
  if (!normalized) {
    return { templateId: null, confidence: 0, matched: [] }
  }

  const scored: { templateId: string; score: number }[] = []

  for (const tpl of QUESTION_TEMPLATES) {
    let best = 0
    for (const ex of tpl.examples) {
      const exNorm = normalize(ex)
      if (!exNorm) continue
      if (exNorm === normalized) {
        best = Math.max(best, 1.0)
        continue
      }
      if (normalized.includes(exNorm)) {
        best = Math.max(best, 0.85)
        continue
      }
      if (exNorm.includes(normalized)) {
        best = Math.max(best, 0.75)
        continue
      }
      // keyword overlap (2+ 文字 token 単位)
      const overlap = countOverlapTokens(exNorm, normalized)
      if (overlap > 0) {
        best = Math.max(best, Math.min(0.65, 0.35 + overlap * 0.15))
      }
    }
    // intent keyword boost
    const intentNorm = normalize(tpl.intent)
    if (intentNorm && countOverlapTokens(intentNorm, normalized) >= 1) {
      best = Math.min(1.0, best + 0.1)
    }
    if (best > 0) scored.push({ templateId: tpl.id, score: best })
  }

  scored.sort((a, b) => b.score - a.score)
  const top = scored[0]
  if (!top) return { templateId: null, confidence: 0, matched: [] }

  // 続 82 Director hot fix (Owner 2026-05-25 07:48 報告):
  //   「昨日、オーガニックアクセスで、即離脱したユーザー数は何％？」が
  //   `TOP_PAGES_BY_SESSIONS` (人気ページ) に誤 hit → 全く違う回答を返した。
  //   threshold 0.75 では keyword 2 つ被るだけで marginal hit してしまうため、
  //   0.85 に厳格化。0.75 〜 0.85 の borderline は freeform に流す。
  //   さらに top1 と top2 の score margin が 0.05 未満なら "曖昧" 判定で reject。
  const HIT_THRESHOLD = 0.85
  const AMBIGUITY_MARGIN = 0.05
  const second = scored[1]
  const isAmbiguous = second != null && top.score - second.score < AMBIGUITY_MARGIN
  const hit = top.score >= HIT_THRESHOLD && !isAmbiguous
  return {
    templateId: hit ? top.templateId : null,
    confidence: top.score,
    matched: scored.slice(0, 5),
  }
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s　、。!?！？]/g, '') // 空白 + 句読点除去
    .replace(/[ぁ-ん]/g, (c) => c) // ひらがなはそのまま
}

function countOverlapTokens(a: string, b: string): number {
  // 2 文字以上の連続 substring を token として match
  const tokens = new Set<string>()
  for (let i = 0; i < a.length - 1; i++) {
    tokens.add(a.slice(i, i + 2))
  }
  let overlap = 0
  for (let i = 0; i < b.length - 1; i++) {
    if (tokens.has(b.slice(i, i + 2))) overlap++
  }
  return overlap
}

/** Template ID から template 取得 (orchestrator が toolPlan を取り出すのに使用) */
export function getTemplate(templateId: string): QuestionTemplate | null {
  return QUESTION_TEMPLATES.find((t) => t.id === templateId) ?? null
}
