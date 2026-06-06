# UGOKI Crawl × UGOKI MAP 融合 実装設計書 (2026-06-06)

行動データ(UGOKI MAP) × コンテンツ/クローラー(UGOKI Crawl, 旧 linkscrawl) を突合し、チャットに
**「行動で裏取りした"直す順"(Behavior-Validated Fix Prioritization)」** を出す統合。
調査(3 Explore) + Codex 4 ラウンドで確定。承認プラン: `.claude/plans/glistening-churning-rose.md`。

## 1. 楔と差別化
クロール/a11y/perf/コンテンツの問題＋セクション摩擦を「**実ユーザーが実際に苦しんだ順**」で提示。
GA4/Hotjar/Clarity/Screaming Frog のいずれも原理的に出せない(行動と問題分類の両方を1社で持つのが UGOKIMAP だけ)。
> 例: 「このCTA区間はa11yコントラスト欠陥＋画像読込が遅い。だが#1の理由は、38%が到達・rageが基準2.7倍・この区間以降でアシストCVが落ちるから。」

## 2. 最重要前提: セレクタ優先突合
クローラーは固定 1280×800 描画 → section の y は desktop系。実ユーザーは responsive 多ビューポート →
**y だけの突合は壊れる**。対策:
- `content_map.py` が **section_selector / selector_hash / dom_path / viewport / page_height ＋ text/asset/cta_hash** を出力。
- `element_matcher` を **セレクタ包含マッチ優先**(events.element_selector ⊂ section_selector)、y は同 viewport_class 内フォールバック。
- 対象ページは **mobile(390×844)+desktop(1280×800) 2クロール**。

## 3. スキーマ: 新規6 ＋ 再利用5
### 新規 ClickHouse 5 (`migrations/2026-06-06-ugokicrawl-fusion-clickhouse.sql`)
- `crawl_runs` (ReplacingMergeTree): クロール実行台帳・最新crawl・冪等。
- `page_content_sections` (MergeTree, append): セクション地図 + 変更検知 hash。クロール間 diff の源泉。
- `page_performance` (MergeTree): ラボ LCP/CLS/INP (数値時系列、web_vitals 実測と突合)。
- `page_issues` (MergeTree): 定性 findings (SEO/a11y/perf/content)、metric_* で数値参照。
- `section_behavior_summary` (ReplacingMergeTree): 行動を section×日 で事前集計 + friction_score + match_confidence。
### 新規 Postgres 1 (`linkscrawl/migrations/021_intervention_events.sql`)
- `intervention_events` (append-only): 介入決定の台帳 = 後から復元不能な唯一の信号 (因果の治療時計)。
### 再利用
`page_structure`(+crawl_id/viewport_class: `..._clickhouse.sql` の ALTER) / `ml_event_section_map`(+viewport_class/section_selector_hash) / `analysis_jobs` / `proposal_tickets` / `web_vitals` / raw `events`。
### page_content_map 列追加 (`linkscrawl/migrations/022_content_map_selectors.sql`)
selector/hash/dom_path/heading/viewport/page_height/text_hash/asset_hash/cta_hash。

## 4. ETL: MAP が pull (Codex)
ugokicrawl が `crawl_export_v1`(additive-only, 破壊は v2) を Postgres/API から発行 → UGOKI MAP の
**自前 ingestion** が検証→ClickHouse 投入(source_system/version/crawl_id/ingested_at 保持)。直push は `crawl_raw_*` 限定。

## 5. チャットツール (UGOKI MAP)
- `rank_behavior_validated_fixes(dateRange, page_url?, limit)`: page_issues × section_behavior_summary × page_content_sections を突合し、**重大度×摩擦×到達**で"直す順"を返す。最新crawl基準。低 match_confidence は除外表示。
- `explain_section_friction(page_url, section)`: 1区間の 行動(summary) × 内容(sections) × 問題(issues) × 最寄CTA を統合提示。
- 未取込サイトは `analytics_data_readiness` 流儀で「クロール未取込」と graceful。

## 6. 閉ループ (Phase 3)
ugokicrawl `generate_proposals`(Ollama) → export → proposal_tickets(原案) → deep-research worker が
行動で裏取り(section_behavior) → M Agent 提示。適用した介入は `intervention_events` に記録。

## 7. フェーズ
- 0: セレクタ化(crawler) + 6表DDL + 契約。 1: 48hクロール+融合→export, MAP ingestion 投入。 2: 楔チャット2本。 3: 閉ループ。 4: enrich/ML系統。
- 最速デモ = 0+1+2 (bihadashop/wakegai 限定)。

## 8. ML ロードマップ (v1 を増やさない)
不変 events ＋ intervention_events ＋ content snapshot の3基盤が全ML系統をバックフィル安全に支える。
各系統は将来 "出力表1本" を足すだけ: アップリフト/因果 / Next-Best-Action(variant_assignments) /
傾向・Look-alike(model_predictions+audience_exports) / アトリビューション(events.utm/gclid/visitor_id 既存+外部広告費は後でbackfill) / フォーキャスト / 生成NLP(ugokicrawl 既存)。

## 9. 改称 linkscrawl→ugokicrawl
互換レイヤ: UGOKICRAWL_* 併存追加(LINKSCRAWL_DATA_ROOT 残す)→deprecation→呼出更新→二重稼働→旧名削除。
歴史テーブル名/cron/サービス名/Dockerボリュームは最後。

## 10. リスク + ガードレール
①突合が雑→優先順位腐る: セレクタ優先+2viewport+confidence、低信頼は裏取り扱いにしない。
②スキーマdrift→チャット壊れる: MAP-owned ingestion + versioned契約 + 書込前検証。
③初回が重い: ランキング1本+説明1本+issue統合1表+2サイト限定。

## 11. Owner/Infra 依存
6表DDL適用(CH5+PG1)+grants / 48hクロール+日次ETL scheduler(GHA or Owner機)+Ollama / 本番デプロイ。
