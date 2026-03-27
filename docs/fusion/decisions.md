# UGOKI MAP 2.0 - Fusion Decisions

## 2026-03-21 Frontend Programmer 初回タスク完了

### [→Operator] behavior_signalsパイプライン修正完了

**問題**: ClickHouseの`behavior_signals`テーブルにデータ0件。
tracking.jsの基本イベント（pageview, click, scroll_depth）は正常に27,818セッション蓄積済み。

**根本原因**: `tracking-ext-behavior.js` のGTMロード時の競合条件。
GTM経由でロードされると、`tracking.js`（コアスクリプト）より先に実行される場合があり、
`window.ClickInsight` が未定義のため**サイレントに終了**していた。

**修正内容**: `tracking-ext-behavior.js` にリトライ機構を追加。
`window.ClickInsight` が未定義の場合、100msごとに最大5秒間リトライする。
バックエンドパイプライン（API→Redis→Inngest→ClickHouse）は全て正常、コード変更なし。

**確認依頼**:
- 修正後のデプロイ後、behavior_signalsテーブルへのデータ蓄積を確認してほしい
- 確認クエリ: `SELECT event_type, count() FROM clickinsight.behavior_signals GROUP BY event_type`
- データが入り始めるまでに、実ユーザーがtext_copy/tab_return等のアクションを行う必要あり

---

### [→ML Programmer] tracking-ext-behavior.js イベント一覧（特徴量設計用）

behavior_signalsテーブルに蓄積される6種のイベント:

| event_type | 発火条件 | 感情推論の意味 | 主要カラム |
|-----------|---------|-------------|----------|
| `text_copy` | ユーザーがテキストをコピー | 比較・評価意図（最強シグナル） | copied_text, copied_length, copy_y, element_path |
| `scroll_reversal` | ページ離脱時（flush） | 混乱・躊躇・再評価 | reversal_count, final_scroll_y |
| `tab_return` | 他タブから復帰 | 他サイトとの比較行動 | away_duration_ms, tab_switch_count, return_scroll_y |
| `browser_back` | ブラウザバック操作 | 不満足（最強ネガティブシグナル） | from_url, scroll_y_at_back, scroll_depth_at_back |
| `pinch_zoom` | モバイル2本指ズーム（>1.3x） | 強い関心（画像拡大） | zoom_scale, zoom_y, target_tag, target_src, target_alt, pinch_zoom_count |
| `cta_hover` | ページ離脱時（flush, CTA上で300ms以上ホバー） | 購入躊躇 | element_path, element_text, hover_duration_ms, hover_y, hover_clicked |

**共通カラム**: id, site_id, session_id, page_url, event_type, element_path, element_text, device_type, created_at

**特徴量設計への注意点**:
- `scroll_reversal`と`cta_hover`はページ離脱時（flush）にまとめて送信される → セッション単位の集計値
- `text_copy`, `tab_return`, `browser_back`, `pinch_zoom`は発生時即送信 → 個別イベント
- `cta_hover`の`hover_clicked`フィールド（0/1）は「CTAに近づいたが押さなかった」vs「押した」の分類に使える
- `away_duration_ms`（tab_return）は比較サイト滞在時間の推定に使える

**ClickHouseテーブル**: `clickinsight.behavior_signals`
**スキーマ定義**: `ugokimap/lib/clickhouse/schema.ts`
