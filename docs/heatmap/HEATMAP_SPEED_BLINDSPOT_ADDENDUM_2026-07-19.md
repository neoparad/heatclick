# 追補: Claude×Codex 統合結論の共有盲点 (3-agent 探索結果)

> 作成: 2026-07-19 / 対象: `HEATMAP_SPEED_CORE_CAUSES_FINAL_2026-07-19.md` (以下 FINAL)
> 手法: 両分析文書を攻撃対象に、プラットフォーム層/ブラウザ側/到達性レッドチームの3視点で「両者が書いていない速度要因」を実コード・実設定から探索
> 結論: **到達性判定を「到達圏内」→「条件付き (at_risk)」に格下げ訂正**

---

## 1. 両者が見落とした主要因 (影響順)

### B-1. Vercel function cold start が毎訪問発生 【残差 3-7秒の最有力候補】
- vercel.json に regions/functions 設定なし。1 function あたり JS trace 実測 ~20MB + Sentry v8 init。SSR page / tiles / screenshot (maxDuration=90 で確実に別 bundle) が多重 cold start
- 利用者が実質オーナー1人 = Vercel の instance 保温 (~5-15分) を毎回外れる。既存 cron (*/5) は別 bundle で保温効果ゼロ
- **推定 +1.5〜4.5s/訪問** — FINAL §2 の「未説明残差 3〜7秒」の大部分を単独で説明し得る。両文書に「cold start」という語が一度も出ない

### B-2. presigned URL ローテでブラウザキャッシュが構造的に無効
- L1 hit でも毎回再署名 (`r2-screenshot-cache.ts:445-461`) → URL が毎回変わり、**オーナーの再訪でも MB級 JPEG を毎回全量再DL** (R2 PUT に Cache-Control も無し)
- **+0.5〜2.0s が毎回の恒久 floor** — 「CDN 化」だけでは解決しない (URL 安定化が同時に必要)

### B-3. 「elements は canvas 非依存」は両者とも誤り
- elements 到着で canvas のタグ・警告色・画像スポットが丸ごと差し替わる (`view-model.ts:764-774`, `heatmap-canvas.tsx:445-449`)
- **視覚完成 (ピクセル安定) は実質 max(C,D,E)** — Codex の「E は必須待ちでない」と FINAL の「E はサイドパネル」は両方コードと矛盾

### B-4. Vercel region 未指定 = 既定 iad1 (米国東部)
- 日本(オーナー)→米国(function)→独(CH) の3大陸往復。Codex の RTT 248ms は調査PC発で Vercel 発ではない
- fra1 固定なら CH 多クエリ route (elements 等) は −0.4〜0.5s。単一クエリ route はダンベル構造上 region では縮まない (この切り分け自体が両文書に無い)

### B-5. 週次 cold 再発の構造 【10-12s 観測と時期整合】
- STALE 7d + SWR 再撮影未完了 (detached promise) の組合せ → **capturedAt が更新されず、v12 一斉撮影 (git 318d30f = 7/04) の7日後 = 7/11 以降の閲覧が同期 capture 対象**
- オーナーの 10-12s 観測時期と整合する**検証可能な仮説**。bump 実績 11回/32日が続く限り Plan C 後も再発

### B-6. その他の未計上要因
- 他デバイス先読み (+4s/+8s) が cold 時に同期 capture を最大3倍化、dedupe lock は device 別キーで効かない (`heatmap-canvas.tsx:392-403`)
- 26MP/q75 JPEG = 1.6〜5MB。FINAL §5 の floor 式から decode 項が脱落 (D' 実質 1〜3.5s)
- tiles キャッシュの hit 率分析なし: 組合せ 4,320/site。恒常 2s には日次 rollup MV が本筋、キャッシュは補助
- regex 正規化は tiles だけでなく **8クエリ全部** (pages SSR / ownership / elements×5 / page-stats) — P1 で同時張り替え必須
- ページ切替時の 4 fetch 二重発火 (device 追従 effect) — CH 二重課金
- 「Clarity 1-2秒」は非対称比較。「2秒」の定義 (視覚完成/全UI/体感) がオーナーと未合意
- USER_REGISTRY=db cutover 時に全 route +0.1〜0.4s の将来退行 (予算未計上)
- 【バグ】screenshot が tiles より先に届く窓で、実ページの上に**無関係なモック fixture 熱点が誤描画** (`view-model.ts:681-689` meta null → MOCKUP_VIEW_MODEL)。D-07 違反疑い — 速度と独立に修正すべき

## 2. 到達性の訂正判定

| シナリオ | 現行計画 (P0-P2) 完遂後 | 深い構造変更込み |
|---|---|---|
| 連続利用中 (全層 warm) | **1.3〜2.5s** ✅ | 0.9〜1.8s |
| **オーナーの実利用 (その日の初回)** | **2.5〜6s** ❌ | **~2s 圏** ✅ |

**FINAL の「0.9-2.4s で到達圏内」は warm-everything の理想条件でのみ成立**。恒常 2秒の追加条件:

1. 保温 or warm 前提の放棄 (cron ping / Fluid Compute 確認 / 「全 miss でも 2s」の事前集計設計)
2. 画像 URL の安定化 + Cache-Control immutable (B-2)
3. 画像予算の確定 (~300-500KB 級への再設計。26MP/q75 のままでは CDN 化しても D' 1-3.5s)
4. region 確定 (fra1 pinning の計測判断)
5. 事前集計 rollup MV (キャッシュ hit 依存の放棄)
6. Plan C パリティの自動テスト + r2-fresh 率の常時計測 (静かな全 miss は検知されない)
7. SWR 完了保証 + bump 時の backfill 完了ゲート (B-5 の週次再発遮断)
8. E の canvas 後書き換え排除 (タグ用上位データを初回応答に同梱)

## 3. P0 計測仕様への追加 (FINAL §4 P0 に追記)

- cold start 判別フラグ (function init 時間 — Server-Timing だけでは見えない)
- `VERCEL_REGION` の記録
- image bytes + `img.decode()` 完了 mark + 各 re-render 境界 mark
- tier (l1/r2-fresh/r2-stale/cold) 別の頻度分布 — 「D の実効 warm 率」の実測
- 計測前に**「2秒」の定義をオーナーと合意** (どの瞬間にストップウォッチを止めるか)
- 他デバイス先読みを計測中は無効化 (交絡排除)
- Clarity を同一ページ・同一回線で DevTools 計測し比較基準を実数化
