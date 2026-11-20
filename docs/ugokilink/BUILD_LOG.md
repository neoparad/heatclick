# UGOKI LINK v2 構築ログ（BUILD_LOG）

ブランチ: `feat/ugokilink-v2`（起点: `claude/inngest-clickhouse-review-c87b69` `683203b`）
統括セッション: `4f6aeb14-d5e9-4496-b7ad-bd5574b3fd93`

| 日時 | 束 | 設計書§ | 実際に行ったこと / 判断 | 理由 |
|---|---|---|---|---|
| 2026-11-20 | Setup | §3 | `claude/inngest-clickhouse-review-c87b69` (`683203b`) から `feat/ugokilink-v2` を作成。未追跡の作業資料フォルダ `docs/proposals/2026-11-19-ugokilink-v2-working/` をワークスペースに配置し `.git/info/exclude` に登録 | 4レーンから参照可能にしつつ、公開リポジトリへの誤コミット/pushを物理的に防ぐため |
| 2026-11-20 | 0-A (先行) | §11.9 / §13.2 | コミット `6d9ef18`: `lib/llm/hybrid-query.ts` の SQL 文字列直埋め込み 4 箇所を `{page_url:String}` / `{cta_page_url:String}` パラメータバインド化、`public/v2/tracking.js`・`public/tracking.js` に同期 PII/URL サニタイズ内蔵＆`img.alt` setter ロック除去、`public/recording.js`・`public/track.js` 削除、`workers/event-ingest` の非ブラウザ直叩き 403 遮断を実施 | 既存稼働タグの安全性確保および 0-A の SQL インジェクション修正を完了させるため |
