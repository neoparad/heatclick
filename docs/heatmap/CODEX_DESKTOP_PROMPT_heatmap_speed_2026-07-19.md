# Codex Desktop 委譲プロンプト — ヒートマップ 10-12秒問題: v2 レビュー + 独自徹底分析

> 作成: 2026-07-19 / 宛先: Codex Desktop (gpt-5.6-sol, リポジトリ C:\Users\M2603\ugokimap-saas)
> ⚠ `docs/heatmap/CODEX_PROMPT_sol_heatmap_speed_2026-07-18.md` は前提誤りを含むため**破棄** (本書が置き換え)
> ゴール: あなた (Codex) と Claude の両輪で「10-12秒の中核要因」を確定させる。あなたの結果は Claude が突き合わせ、共同の最終アウトプットにする。

---

## 背景

ヒートマップ画面 (`/heatmap`) の表示完了まで 10-12秒 (オーナー実測、本番)。Microsoft Clarity は 1-2秒。商品として成立しない水準。内訳計測データは未取得。

Claude が初案を書き、4-agent 実コード検証で自己訂正した結果が
**`docs/heatmap/HEATMAP_SPEED_ROOT_CAUSE_v2_2026-07-19.md`** (以下 v2) にある。
v2 の中核仮説: 「10-12秒は cold capture の事故ではなく、**warm path の構造コスト
(SSR直列 gate + client chunk + tiles CHクエリ ~3s + スクショ配信鎖 + 非CDN の MB級 JPEG)** の合算」。

## Part A — v2 のレビュー (敵対的)

v2 の §0〜§3 を読み、全主張を実コードと突き合わせて検証せよ。
- 誤り・過大・過小があれば **file:line 付き**で指摘 (根拠なし指摘は不可)
- 壊せない主張は CONFIRMED と明言
- §2 の区間レンジ推定 (warm 8-13s) の妥当性を独立に判定

## Part B — 独自の徹底分析 (v2 に引きずられるな)

v2 を読む**前**に自分の目でコードを追い、独立に「10-12秒の帰属仮説」を立ててから Part A に入ることを推奨する。
さらに、あなたは実環境にアクセスできる — **推測を実測に変えろ**:

### B-1. ClickHouse 実測 (tunnel `https://ch.bihadashop.jp` 経由、認証情報は .env / 過去セッションと同様)
1. `system.query_log` から heatmap 系クエリ (clickinsight.events への click/read/scroll 集計) の **query_duration_ms 分布** (直近7-14日、p50/p95/max)。tiles の「~3s 実測」コメント (app/api/heatmap/route.ts:592) の現在値を裏取り
2. read_rows / read_bytes / result_bytes も併記 — 「3s の内訳が CH 実行なのか転送なのか」を分離
3. tunnel RTT: 軽量クエリ (SELECT 1) の往復時間を数回計測
4. elements 系 5 クエリ (elements/route.ts:148,180,226,268,317) の各 duration — 直列合算のコストを実数化

### B-2. R2 / スクショ実測
1. R2 メタ JSON (captureVersion v12) から bihadashop 各ページの **画像バイトサイズ実測分布**
2. 可能なら署名URL 1 本の実 DL 時間 (MB級 JPEG の非CDN 配信コスト)

### B-3. 本番エンドポイント計測 (可能なら)
- 認証 cookie が使えるなら `curl -w` で `/api/heatmap` (tiles) / `/api/heatmap/screenshot` の TTFB・total を warm/2回目で計測
- 不可ならその旨を明記し、B-1/B-2 からの推定で代替

### B-4. コード面の独自調査 (v2 が見ていない範囲も)
- Next.js ビルド出力 (client chunk サイズ)、`app/(proof)/heatmap/page.tsx` の SSR gate
- 私 (Claude) が見落とした速度要因があれば自由に追加せよ

## Part C — 出力 (以下の構成で `docs/heatmap/CODEX_ANALYSIS_heatmap_speed_2026-07-19.md` に書き出し)

```
## 1. v2 レビュー結果 (指摘テーブル: 深刻度 / 対象§ / 指摘 / 根拠 file:line / 修正案)
## 2. 実測結果 (B-1〜B-3 の数表。実行した SQL / コマンドを併記 — 再現性必須)
## 3. 独自の帰属分析 (10-12秒の区間内訳、実測ベース。v2 §2 との差分を明示)
## 4. 中核要因 Top 3 (あなたの判定。各要因に: 寄与秒数推定 / 根拠 / 対策案 / 工数感)
## 5. v2 改善候補 (§3 の 1-8) への評価 (効果順の並べ替え + 追加提案)
```

## 制約

- **読み取り専用** — 本体コードの変更・commit は今回スコープ外 (計測用の一時スクリプトは scratch 領域なら可)
- CH クエリは tenant=`linkth_internal` / site=`CIP_EcwUTHEZdIOAUqum` 範囲、`is_agent=0`、重いクエリには LIMIT / max_execution_time を付ける
- 本番に負荷をかける計測 (連打・大量リクエスト) は不可。各計測は数回まで
- 並行ストリームの未コミット差分 (`components/heatmap/heatmap-canvas.tsx` 等) は読み取りのみ
- 数値主張には必ず「実行した SQL/コマンド + 実行日時」を添付 (再現性のため)
