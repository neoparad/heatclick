# 改善提案メモ：Inngest再設計・スマート計測・ClickHouseメモリ最適化 ＆ 残存課題整理

- **作成日**: 2026-11-12
- **ステータス**: 方針合意済・詳細設計＆セカンドオピニオン検証フェーズ
- **対象リポジトリ**: `ugokimap-saas`

---

## 1. 背景と本番実測ファクト（2026-11時点）

本番 ClickHouse（`clickinsight` DB）およびリポジトリ実装を突合した結果、以下の実態が確認された。

### 1.1 稼働媒体とイベント流入量
登録済6媒体（`tenant_id = 'linkth_internal'`）のうち **5媒体が稼働中**（累計 **約7,454万行**、直近30日で **約991万行 / 16.4万PV**、直近24時間で **約29.8万行 / 5,323 PV**）：

| 媒体名 | ドメイン | `site_id` | 累計イベント | 直近30日イベント (PV) | 状態 |
|---|---|---|---:|---:|---|
| わけがい | `https://wakegai.jp` | `CIP_QWaPiks5krukJ6NM` | 37,091,784 | 5,612,568 (131,467 PV) | 稼働中（最大流入・約50%） |
| コスメ部 | `https://bihadashop.jp` | `CIP_EcwUTHEZdIOAUqum` | 18,370,461 | 1,000,897 (7,320 PV) | 稼働中（1PVあたり約136件） |
| 防水工事見積り.com | `https://bousuikouji.info/` | `CIP_8eN7xgfBtDAnzE26` | 16,899,958 | 3,278,853 (25,267 PV) | 稼働中（1PVあたり約130件） |
| neverseen | `https://nvrseen.com` | `CIP_6r2WofQDSKrOwxmM` | 124,859 | 9,384 (269 PV) | 稼働中 |
| LINKTH コーポレート | `https://link-th.co.jp` | `CIP_E3xzSWfXcXx6GaTL` | 53,687 | 9,120 (141 PV) | 稼働中 |
| セカンドライフ | `https://www.ehaiki.jp/second/` | `CIP_xginf3nVacnkn62o` | 0 | 0 (0 PV) | 未稼働（0件） |

### 1.2 イベント種別の偏りとDBメモリ圧迫
- 全7,454万行のうち上位4種で **93.98%** を占める：
  1. `scroll`: **56,397,770行（75.70%）** — 200msスロットルで連続送信
  2. `read_area`: **6,067,996行（8.14%）**
  3. `scroll_anchor_hit`: **4,798,115行（6.44%）**
  4. `alt_read_signal`: **2,757,227行（3.70%）**
  - （参考）`pageview` は 1,215,784行（1.63%）、`click` は 330,446行（0.44%）。
- ClickHouse 上で中〜長期集計クエリを実行すると **`MEMORY_LIMIT_EXCEEDED (maximum: 4.54 GiB)`** が実際に発生する。これが「ヒートマップ表示が遅い・途中で途切れる（ダミー退避する）」根本原因の1つになっている。

### 1.3 Inngest の現状
- 旧構成（ClickInsight Pro 時代）の `warm-heatmap-cache`（6時間ごとに人気100ページ×3期間＝300 step）等が `app.inngest.com` 側で残存消費している一方、現行 `ugokimap-saas` の `inngest.config.ts` は `export const functions = []`（未接続）のままになっている。

---

## 2. 合意した3つの改善柱

### 柱①：Inngest を「新システムに必要なジョブ」へ正式に繋ぎ直す
- **方針**: 旧システムの不要なキャッシュウォーミングCronは停止し、`ugokimap-saas` 側に `/api/inngest` を正式実装して、Vercel API の実行時間制限を超える非同期処理・監視・定期バッチを担わせる（生イベント受信自体は引き続き Cloudflare Worker → ClickHouse 直書きとする）。
- **繋ぎ直すジョブ候補**:
  1. **データ欠損・イベント途絶監視（死活アラート）**: 稼働サイトの直近イベント流入やWorker書き込み異常を定期チェックし、無音停止インシデントを即検知。
  2. **人気URLのスクリーンショット事前撮影（R2 Pre-warm）**: 各サイト上位ページのR2スクショを夜間更新し、ヒートマップ初回表示時の撮影待ち（Cold miss）を解消。
  3. **LINKTH CRAWL × GSC / GA4 の定期同期・差分監査**: 長時間かかるクロール監査・外部指標取り込みの `step.run` 分割実行＆リトライ。
  4. **A/Bテスト有意差到達通知・ML/統計スコアの日次更新**。
  5. **ClickHouse 日次バックアップ ＆ 個人情報削除請求（14日後 HARD DELETE）**。

### 柱②：`tracking.js` の「スマート・スクロール計測」（精度維持で通信・保存量を約85%削減）
- **方針**: 単純にスロットル秒数を延ばすのではなく、**ブラウザ内では高精度（200ms）に状態監視を続け、サーバーへ送信するイベントだけを賢く絞る**。
- **根拠**:
  - ヒートマップの `scroll` / `exit` レイヤー（`app/api/heatmap/route.ts`）は `GROUP BY session_id` の `max(scroll_percentage)` しか使っていない。
  - `read` レイヤーはブラウザ側で500ms停止を検知して送る `read_area` イベントを使っており、`scroll` 間引きの影響を受けない。
  - 一方、`lib/analysis-axes.ts` の「上下迷い率（`confusion_rate`）」と「スクロール速度ペルソナ（`scroll_speed_persona`）」は途中の `scroll` 行を参照している（しかも ClickHouse 側の `timestamp` が秒単位 `DateTime` のため、200ms送信だと同一秒に潰れて `diff_ms = 0` で破棄される無駄が生じている）。
- **スマート送信ルール案**:
  - 5〜10%刻みの新深度更新時、上下方向の折り返し頂点（逆走発生点）、1秒以上経過した移動サンプル、停止・離脱時の最終到達点を送信することで、ヒートマップ・迷い検知・速度ペルソナの体感精度を一切落とさず（むしろノイズを減らして）`scroll` 行を約85%削減する。

### 柱③：ClickHouse のメモリ詰まり解消（要約ロールアップ保存 ＋ 古い生 `scroll` の自動整理）
- **方針**: 4.54 GiB メモリ上限によるクエリ失敗・遅延を恒久解消する。
- **具体策案**:
  1. **セッション×URL単位のロールアップ集約（Materialized View 等）**: `max_scroll_percentage`, `max_scroll_y`, `reversal_count`, スクロール速度統計などを事前集約し、ヒートマップ（Scroll/Exit）やAI分析が数千万行の生 `scroll` を毎回フルスキャンしない構造にする。
  2. **条件付き TTL（自動寿命管理）**: `click` / `read_area` / `pageview` / CV / 要約テーブルは長期保持したまま、役目を終えた古い（例：90日超の）細かい生 `scroll` 通過行のみを自動整理する（ClickHouse `MergeTree` における `DELETE` TTL のディスク再マージ負荷も含め、最適な TTL / パーティション戦略を設計する）。

---

## 3. 他にも詰めるべき論点・点検項目（Open Questions）

1. **他の大量イベント（`scroll_anchor_hit` 480万行 / `alt_read_signal` 275万行 / `scroll_timeline`）の要否**
   - 現行プロダクト画面やML・AI分析で実際に参照されているか？使われていない拡張スクリプト（`config.extensions = 'all'` で全読込中）が無駄にネットワークとDBを消費していないか？
2. **環境変数名・接続経路のズレ**
   - `lib/clickhouse.ts` は `CLICKHOUSE_RO_PASSWORD` / `CLICKHOUSE_WRITER_PASSWORD` を参照するが、環境によって `CLICKHOUSE_ANALYTICS_PASSWORD` / `CLICKHOUSE_CHAT_PASSWORD` が設定されている箇所や、旧直接IP設定が残っている箇所がないか？
3. **残存セキュリティ・クォータ保護・安定性**
   - `/api/pagespeed` 等の外部APIクォータ消費リスク、R2スクショ Cold Capture 時の同時アクセス重複撮影（Single-flight lock 不在）、`event-ingest` Worker と本体のスキーマ/バリデーション整合性など、限定公開・本格運用前に潰すべき穴が他にないか？
