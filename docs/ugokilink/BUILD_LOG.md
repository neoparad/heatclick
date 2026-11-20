# UGOKI LINK v2 構築ログ（BUILD_LOG）

ブランチ: `feat/ugokilink-v2`（起点: `claude/inngest-clickhouse-review-c87b69` `683203b`）
統括セッション: `4f6aeb14-d5e9-4496-b7ad-bd5574b3fd93`

| 日時 | 束 | 設計書§ | 実際に行ったこと / 判断 | 理由 |
|---|---|---|---|---|
| 2026-11-20 | Setup | §3 | `claude/inngest-clickhouse-review-c87b69` (`683203b`) から `feat/ugokilink-v2` を作成。未追跡の作業資料フォルダ `docs/proposals/2026-11-19-ugokilink-v2-working/` をワークスペースに配置し `.git/info/exclude` に登録 | 4レーンから参照可能にしつつ、公開リポジトリへの誤コミット/pushを物理的に防ぐため |
| 2026-11-20 | 0-A (先行) | §11.9 / §13.2 | コミット `6d9ef18`: `lib/llm/hybrid-query.ts` の SQL 文字列直埋め込み 4 箇所を `{page_url:String}` / `{cta_page_url:String}` パラメータバインド化、`public/v2/tracking.js`・`public/tracking.js` に同期 PII/URL サニタイズ内蔵＆`img.alt` setter ロック除去、`public/recording.js`・`public/track.js` 削除、`workers/event-ingest` の非ブラウザ直叩き 403 遮断を実施 | 既存稼働タグの安全性確保および 0-A の SQL インジェクション修正を完了させるため |
| 2026-11-20 | 1-A | §3.1, §4.1–§4.7, §5.7, §6.4 | `packages/contract/schema/` に単一正本スキーマ `CANONICAL_SCHEMA` と6つの決定論的生成器（SDKバイナリ符号化/検証・部分受理受付検証・ClickHouse/Postgres DDL・TS API型・日本外部送信規律開示文面・14日削除計画）を実装。未分類URLパラメータは設計書§6.4（正本優先）に従い形状情報を出さず長さ区分トークンのみ出力＋`key_degraded=true` | 設計書優先原則（実装計画§3）および入力値漏洩ゼロ・再生成差分ゼロをCIで保証するため |
| 2026-11-20 | 1-E | §1.3, §9.10, §11.5, §11.11(13) | `packages/contract/response/` に唯一の返答直列化器・検証器（8状態・4根拠レベル・I1〜I7全ガード・非公開Symbolブランド型 `VerifiedMetricValue<T>`・`UntrustedValue`漏れ検出・`residency`）を実装 | REST/SDK/MCP 全経路で未検証数値・`proven`未満の点見込み・未包装外部文字列送出を物理的に遮断するため |
| 2026-11-20 | 0-D | §7.1, §7.2, §13.1 | `lib/link/clocks/actor-evidence-snapshot.ts` に24公式ソースのIP JSON/SAIL TOML/RFC 9421 JWKS改変不能スナップショット保存・過去時点照会を実装（`nightly_wave0`では`refuted`非発火、`production_poll` 3連続不一致で発火） | 過去に遡れない事業者IP/鍵一覧の時計を即座に回し、誤否定を防ぐため |
| 2026-11-20 | 1-C | §6.4 | `packages/contract/urlkey/urlkey.ts` に単一権威URLキー関数 `computeUrlKeyV2`（IDN/壊れた%・4分類・未分類長区分のみ・パス内検索語マスク・360適合ベクトル全通過＆冪等性検証）を実装 | 設計書§6.4優先で入力語漏洩ゼロと両システム完全一致を保証するため |
| 2026-11-20 | 1-D | §6.1 | `packages/contract/segmenter/` に外部依存ゼロ共通区切りプログラム＆軽量HTML5パーサーを実装（全照合キー `sec_fp`/`body_fp`(128b)/`skel_fp`/`css_fp`/`el_fp`/`head_fp`/`links_fp`/`res_fp`/`slot_fp`、実験中ID不変、固定220ページ HTML vs DOM 220/220完全一致） | 端末差・広告・実験書き換え・改版でも崩れない構造突合核を確立するため |
| 2026-11-20 | 0-B | §12.4 / §13.2 | `docs/ugokilink/CRON_INVENTORY.md` を作成し稼働定期実行4本・Inngest・Workers・GH Actionsを棚卸し。`inngest.config.ts` を旧スタブ撤去・`functions = []`（登録旧ジョブ0件・Wave 4-F ML制御面専用）へ整理。監査所見として `/api/experiments/pool` の認証不統一を記録 | 既存稼働定期実行を壊さず責務分離と停止条件を明確化するため |
| 2026-11-20 | 0-C | §13.2 / Q-0 | 読み取り専用スクリプト `scripts/link/inspect-prod-baseline.mjs`（`.env*` 非参照・SELECT/SHOW限定・秘密値サニタイズ・`--dry-run` 38クエリ検証）を作成 | オーナーが安全に本番DDL・利用者・旧データ全数調査を採取するため |
| 2026-11-20 | 1-B | §4.9 / §12.2 / §14 | `packages/contract/ledgers/` に4台帳（`gates.ts` 236件・`constants.ts` 88件・`unknowables.ts` 21件・`decisions.ts` 34件、D-31b Jev学習永久禁止ロック含む）を構築 | 全波のAPI・ゲート評価・CI監査が単一の語彙と `not_entitled` ガードを共有するため |
