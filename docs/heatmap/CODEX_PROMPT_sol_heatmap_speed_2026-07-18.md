# Codex sol 委譲プロンプト — ヒートマップ表示 10-12秒 問題の解決提案

> 作成: 2026-07-18 / 宛先: codex exec (gpt-5.6-sol, reasoning=high)
> リポジトリ: C:\Users\M2603\ugokimap-saas (trusted)

---

## 症状 (オーナー実測)

- ヒートマップ画面 (`/heatmap`) で**ページが表示されるまで 10〜12 秒** (本番、bihadashop サイト)
- 競合 Microsoft Clarity は同等画面が **1〜2 秒**
- オーナー判定: 「このギャップを埋めないと商品として使えない」
- ⚠ 10-12秒の**内訳計測データは未取得**。どの区間が何秒食っているかは誰も知らない。推測で最適化を語らないこと。

## 確定している構造 (file:line 検証済み — ただし鵜呑みにせず再検証せよ)

### S-1. スクショ underlay: cold miss = リクエスト内で外部レンダリング
- `app/api/heatmap/screenshot/route.ts:12` — Microlink (外部サービス) で server-side capture、in-memory cache (1h / 60 entries)
- `:42-43` — 「コールド capture が platform 既定 timeout で 504 になるのを防ぐ。provider 側 timeout (**60s**) より長くし…」— cold パスは数十秒級であることを route 自身が自認
- `:177-191` — L1 in-memory → R2 L2 → capture の3段 (`lib/heatmap/r2-screenshot-cache.ts`、24h fresh / 7d stale、serve-stale + background-regenerate = Plan A `e1f5c74` 実装済)
- つまり **warm は速いはずだが、cold miss・L1 揮発 (serverless インスタンス毎 60 entries)・R2 miss の頻度が不明**

### S-2. 認証・所有権チェックが CH 往復を含む
- `route.ts:68-85` — `tenantTracksUrl` が ClickHouse クエリ
- CH は Cloudflare Tunnel `https://ch.bihadashop.jp` 経由 (Vercel → Cloudflare → Hetzner の多段往復)。**1クエリあたりの実効 RTT が不明** — tiles も同経路

### S-3. tiles 取得は直列ループ
- `hooks/use-heatmap-tiles.ts:80-` — `do { await fetchHeatmapTile(...) } while(...)` の **直列 cursor ループ**。1 batch = 1 HTTP round-trip (Vercel function) = 1+ CH query (Tunnel 越し)
- eager prefetch は「上限まで**連続直列** fetch」(ヘッダコメント参照)。batch 数 × (function 起動 + CH RTT) が線形加算される構造

### S-4. 併走する独立 fetch 群
- tiles / elements (`hooks/use-heatmap-elements.ts`) / page-stats (`app/api/heatmap/page-stats`) / screenshot が別 API・別往復

### S-5. 構造的解決の設計書は存在するが未実装
- `docs/heatmap-screenshot-pregeneration-design.md` (Plan C / 設計のみ):
  - 「現状の『閲覧毎にサーバで全ページ render』は**業界的に異端で、遅さの主因**」(§2)
  - ugokicrawl が既に Playwright で全ページ full_page screenshot を撮っている → R2 へ流用すれば追加コストほぼゼロ (§3)
  - パリティ要件表 (viewport/DPR/URL正規化/R2キー/メタJSON) は Codex レビュー済 (§4)
  - Clarity/FullStory は **DOM スナップショット再構築方式** = 閲覧時に画像もレンダリングも不要 (§2, §7 に将来選択肢として記録)

## 依頼 (優先順)

### 1. 計測 (attribution) 計画 — 最優先・最初の成果物
10-12秒をどの区間に帰属させるかの計測設計。Server-Timing ヘッダ / client performance marks / 区間定義 (auth / ownership CH / screenshot L1・R2・cold / tile batch 数×各所要 / elements / page-stats / 画像 DL / 描画)。**「計測せずに最適化するな」を自分にも課すこと**。最小実装 (数時間級) で内訳が取れる形を specify せよ。

### 2. 改善提案 — 短期 (数日) / 構造 (Plan C 級) の2層で
各提案に: 期待削減幅 (どの区間を何秒→何秒) / 工数 / リスク / 検証方法。
検討候補 (これに限らない — あなたの提案を歓迎):
- tile 直列ループの並列化 or 1発化 (batch 上限内を Promise.all / サーバ側で1クエリに統合)
- 楽観 UI (スクショを待たず tiles を先に描画 / スケルトン+プログレッシブ)
- L1 の serverless 揮発対策 / R2 ヒット率の実測と TTL 見直し
- ownership チェックの結果キャッシュ (session 内)
- CH Tunnel RTT の削減 (コネクション再利用 / クエリ統合 / エッジキャッシュ)
- Plan C 前倒し (クローラースクショ流用)
- 画像最適化 (フォーマット/サイズ/priority hints — `real-page-screenshot-underlay.tsx:104-107` は fetchPriority=high 済)

### 3. 構造判断: Plan C vs DOM スナップショット vs 折衷
Clarity の 1-2秒 に**原理的に**並ぶにはどの構造が必要か。Plan C (事前生成+CDN) で足りるか、DOM スナップショット (rrweb 系、トラッカー変更を伴う) まで要るか。移行順序と、Plan C が DOM 方式への布石になるか否か。

### 4. 2秒予算の設計
「表示まで 2秒」を区間予算に分解 (例: auth 100ms / データ 600ms / 画像 800ms / 描画 300ms…)。現構造で物理的に不可能な区間があればそれを明示 — それが構造変更の必要十分条件になる。

## 制約

- multi-tenant isolation (§3.8.1): 全 CH クエリ tenant/site 束縛は不可侵
- D-07: 数値捏造禁止 — ローディング中のダミー数値表示は不可 (スケルトンは可)
- トラッカー (tracking.js) 変更は CV定義 C1 が「不要」を確定させた設計原則に抵触するため、DOM スナップショット提案時はトラッカー変更コストを明示すること
- C1 (CV定義) ストリームが並行中 — 提案の実装順序はそれを踏まえる
- working tree の `components/heatmap/heatmap-canvas.tsx` / `heatmap-side-panel.tsx` に未コミット差分あり (別ストリーム) — 読むのは可、変更前提の提案は明記

## 出力形式 (stdout に Markdown)

```
## 1. 計測計画 (区間定義 + 実装 spec)
## 2. 短期改善 (テーブル: 提案 / 対象区間 / 期待削減 / 工数 / リスク)
## 3. 構造改善 (Plan C / DOM snapshot / 折衷の判断と移行順序)
## 4. 2秒予算内訳 (+ 現構造で不可能な区間の明示)
## 5. 推奨実行順 (計測→短期→構造の具体的シーケンス)
```
