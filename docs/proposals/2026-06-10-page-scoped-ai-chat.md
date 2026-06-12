# 起案: ページ単体 AI チャット (Page-Scoped AI Chat)

**日付**: 2026-06-10
**状態**: 起案のみ (Owner 指示: 「aichat より先にヒートマップを仕上げる」)。実装着手は Owner GO 後。
**起点**: Owner 発案 — 「このページ単体のデータに対する aichat があってもいいのではないか？
例: この表を凝視している人の CVR とスルーした人の CVR の差は？」

## 一行

ヒートマップを「見る」道具から「**聞ける**」道具にする。いま見ているページ・要素の文脈を
既存 AI チャット (orchestrator + analytics-tools) に注入するだけで成立 — 新規 ML ゼロ。

## なぜ作るか

- 右パネルには「UGOKIMAP AI に聞く」CTA が**既に設置済み (現在 disabled)** = 設計当初からの予定地。
- 「この表を凝視した人」= `read_area` / `element_visibility` でその要素の y 帯域に滞留した
  セッション → **既存 ClickHouse データで判定可能**。CVR 比較は `segment_compare` / CVR 計測
  (実装済み) の流用。
- 競合 (Clarity/Hotjar) のヒートマップは「見る」止まり。行動×構造×AI 回答は UGOKI MAP の楔。

## ⚠ 設計上の絶対則: 相関と因果 (D-07)

「凝視層 CVR 5.2% vs スルー層 2.1%」は**相関** (真剣な買い手ほど表を読むだけかもしれない =
選択バイアス)。回答は必ず:
1. observed 語彙 + Evidence Level バッジで「相関」と明示
2. n 不足は「未確定」(嘘の有意性を出さない)
3. 末尾に「**因果として確かめる → A/B 検証を開始**」CTA = **標準A/B (宝プロジェクト) への入口**

→ ヒートマップで気づく → AI が定量化 → ワンクリックで A/B 検証 → k匿名横断プールに蓄積、
という製品全体のループの結節点になる。

## フェーズ

| 段階 | 中身 | 前提 |
|---|---|---|
| v1 | 右パネルの AI CTA を活性化: ページ文脈 (URL/device/segment/period/表示中の hotspot・negative) を持って /chat へ deep-link。analytics-tools に `compare_cvr_by_element_engagement(selector or y-range)` を 1 本追加 (凝視層 vs 非凝視層の CVR + lift + n + evidence) | ヒートマップ仕上げ完了後 |
| v2 | ヒートマップ画面にドック型チャット。要素カード/ネガティブスポットのクリック → 「この要素について聞く」(文脈自動注入) | v1 |
| v3 | 回答末尾「A/B で検証」→ 標準A/B モジュール (lib/experiments) 接続 | ② A/B ランタイム完成 |

## 関連起案: competitor-monitor diff エンジン連携 (こちらも待ち)

- **役割A (本命)**: A/B テスト期間中の対象外変更 = **汚染センサー** (宝ハンドオフ「再利用する既存資産」
  に明記済み)。接続時期 = ② の実験ランタイム完成時。実験レコードに開始/終了時刻 + ページ
  snapshot hash の置き場があれば後付け可能 (ハンドオフ準拠で追加作業ゼロ)。
- **役割B**: ページ「変更タイムライン」→ 変更前後でヒートマップ/CVR を混ぜない・change-impact
  質問 (「この変更の前後で CVR は？」) に回答。
- 現時点で接続しない理由: ② ランタイム未完成 / competitor-monitor 自身が Inngest 無料枠超過の
  整理中 / 別プロジェクト連携は versioned 契約 + ingest 方式でやるべき (急造 API 直叩き禁止)。

## 担当ファイル見込み (着手時)

- `lib/llm/hybrid-query.ts` + `analytics-tools.ts` (ツール 1 本追加)
- `components/heatmap/heatmap-side-panel.tsx` (CTA 活性化)
- `/chat` への context 受け渡し (query param or KV 経由)
- ① banner (scenarios) / ② A/B (experiments) セッションと**ファイル衝突なし**

## 着手条件 (Owner が GO を出す前に揃っているべきもの)

1. ヒートマップ仕上げ完了 (続126 デプロイ確認 + 再タグ実行 + スクショ Worker 解決)
2. CVR の分母/CV 定義の確認 (cv 計測は続118 で修正済みだが、ページ単位 CV の妥当性を一度検証)
