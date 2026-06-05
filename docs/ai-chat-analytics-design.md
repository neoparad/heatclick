# UGOKIMAP AI Chat — 分析能力の最大化 設計書 (2026-06-04)

freeform AI チャットが「今あるデータ」で幅広く深く答えられるための分析ツール設計。
Owner 承認済み。Codex gap 分析 + 本番 ClickHouse 実測で接地。

## 0. 実バグ（最優先で修正）
- `page_view` 表記ゆれ: 本番に存在するのは `pageview` のみ（bihadashop 30d で 13,687 件）。`page_view` は 0。
  overview/verify が `page_view` を数えていると PV 指標がほぼ 0 に過少カウント。`pageview` に統一する。
  (lib/llm/hybrid-query.ts の raw path ~L366 付近)

## 1. データ棚卸し（本番実測・接地済）
events 13.7M。event_type 実測: scroll, read_area, scroll_anchor_hit, pageview, alt_read_signal,
click, dead_click, session_end, text_node_dwell, scroll_depth, active_time, rage_click。
form_* は form_interactions 129K、frustration micro-signals は behavior_signals 75K。
他: web_vitals 31K, scroll_timeline 37K, image/element_visibility 計46万, video_events 8K,
heatmap_events 3.5M, sessions。
空/薄: gsc_data=0行（SEO未提供と明示）, page_structure=5行。
注意: bihadashop は conversion イベント無し → CVR=0 は正しい（CV未計測）。

## 2. 設計原則
単一テーブルの格子は汎用 metrics、テーブル結合/順序/相関は専用ツール。
LLM が複数ツールを連鎖して why/改善提案を診断（system prompt に診断の作法を明記）。
共通土台: tool 名ドット禁止 / is_agent=0 で bot 除外 / tenant_id・site_id は server 固定 /
query_params バインド / D-07 evidence / 日付は hybrid-query 既存 helper 再利用(Code 386回避) / analytics_reader。

## 3. ツールセット
### 汎用
- metrics(主力): metric × dimension × filter × time。
  metrics: sessions, pageviews, visitors, new/returning_visitors, cvr, conversions, revenue,
  revenue_per_session, avg_scroll_depth, avg_read_duration, avg_active_time, clicks, dead_clicks,
  rage_clicks, bounce_rate, avg_session_duration, exit_rate
  dimensions: none, page_url, device, referrer_type, utm_source/medium/campaign, visitor_type,
  conversion_type, landing_page, exit_page, hour, day_of_week, day, month
- timeseries: 任意 metric の時系列。
- engagement_depth: スクロール到達率 + 熟読(read_area)。

### 専用（結合/順序/相関）
- cta_funnel / element_performance: element_visibility(_v2) 露出 × click × conversion を
  session_id+url+element_selector で結合。露出比CTR、見られたが押されないCTA。
- form_analysis: form_interactions。項目別 drop、完了率、last_field 離脱。
- frustration / behavior_diagnostics: behavior_signals + dead/rage 合成スコア vs CVR。
- performance_impact: web_vitals p75 LCP/INP/CLS × bounce/CVR。
- funnel: 順序ステップ（sequence_id/previous_url）。
- path: 経路/次ページ/離脱経路。
- compare / correlation: 2指標 or セグメント比較（per-session/entity ペア）。
- (既存) overview/contributors/drilldown/verify。verify filter を utm/visitor/element 等へ拡張。

### 後回し（データ薄/空）
- seo(gsc投入後), media(image/video), bot/agent 分析。

## 4. 実装順（autonomous、各段で本番SQL検証）
- Step 0: page_view バグ修正 + Phase1 agent(top_pages/scroll/attention/device) レビュー統合。
- Step 1: metrics(全 dim/metric) + timeseries + engagement_depth。
- Step 2: cta_funnel + form_analysis + frustration + performance_impact。
- Step 3: funnel + path + compare/correlation + verify filter 拡張。
- 各 Step: 本番 ClickHouse で SQL を read-only 検証 → ローカルで generateText+実ツールが 400 にならず
  回答することを確認 → tsc/build green → commit/push。Owner が deploy → テスト。

## 5. system prompt 強化
新ツールを列挙。診断質問(why/改善)では「複数ツールを集めてから統合」「データ無い領域(SEO/CV未計測)は
正直に未提供と述べよ」。日付は注入済の現在日時基準で相対計算。
