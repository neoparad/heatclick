# 設計: ヒートマップ スクショ事前生成 (Plan C / 設計のみ・未実装)

> 課題: 実ページ(スクショ underlay)が遅い。Plan A(即効・実装済 `e1f5c74`)で warm 経路と
> 署名失効バグは改善したが、**コールドミス＝リクエスト時に全ページrender** という構造は残る。
> 本書は構造的解決 = **レンダリングをリクエスト外へ出す**設計（Codex レビュー反映）。実装は別途承認後。

## 1. ゴール / 非ゴール
- ゴール: heatmap 閲覧時に**サーバレンダリングを発生させない**（毎回キャッシュヒット）。体感の render 待ちを原理的に消す。
- 非ゴール(本書): DOM スナップショット再構築(rrweb 方式)への全面移行（将来の大型選択肢として §7 に記録のみ）。

## 2. 業界背景
ヒートマップ系の標準は「閲覧時にレンダリングしない」：
- **事前生成＋CDN/キャッシュ配信**（Hotjar / Crazy Egg 系）= 本 Plan C。
- **DOM スナップショット再構築**（MS Clarity / FullStory / rrweb 系）= 画像不要・即時・レスポンシブ一致（§7）。
現状の「閲覧毎にサーバで全ページrender」は業界的に異端で、遅さの主因。

## 3. 方式: クローラーのスクショを流用
**追い風**: ugokicrawl の `content_map` 抽出は既に Playwright で **desktop+mobile を全ページレンダリングし `page.screenshot(full_page=True)` を撮っている**。レンダリングコストは支払済 → それを heatmap R2 へ流用すれば追加コストほぼゼロ。

経路: クロール/ingest 時にスクショを heatmap の R2 キー体系で保存 → heatmap route は「キャッシュ or stale 配信」だけ。未在庫ページのみオンデマンド(稀)にフォールバック。

## 4. パリティ要件 (Codex 指摘・必須)
クローラー画像を heatmap が使うには「ただの画像」では不可。以下を heatmap 撮影と一致させる:

| 項目 | 要件 | 根拠 |
|---|---|---|
| viewport 幅 | pc=1280 / sp=390 / tab=820 に一致 | `screenshot-provider.ts:99-103` |
| DPR | **1 固定**（heatmap 座標系前提） | `screenshot-provider.ts:48`, worker `:367-370` |
| full-page + lazy-load | スクショワーカーと同じ全高＋遅延画像 eager 化挙動 | `workers/screenshot/src/worker.ts:229-272,381-384` |
| URL 正規化 | heatmap canonicalizer と**同一文字列**。現状は fragment 除去のみで query は保持 → **utm/query 問題**(events側) と揃える要あり | `screenshot-provider.ts:262-269`, fusion handoff §URL正規化 |
| R2 キー | tenant/site/device/urlHash/version を heatmap と同一スキーマで | `r2-screenshot-cache.ts:393-411` |
| メタJSON | `viewportWidth/naturalWidth/naturalHeight/capturedAt/provider/captureVersion/imageContentType` を付与（座標計算が依存） | `r2-screenshot-cache.ts:342-355`, `stage-layout.ts:98-112` |

## 5. 配信契約 (Codex 推奨)
- **基本 = serve-stale + background-regenerate**（既存の 24h fresh / 7d stale ロジックを活用、`r2-screenshot-cache.ts:160-171`）。
- **202 (生成中) は「未クロール＝stale も無い」場合のみ**。インタラクティブ画面で毎回 202+ポーリングにしない。
- 鮮度更新トリガ: クロール cadence ＋ 既存の **`text_hash/asset_hash` 変更検知**で該当ページのみ再撮影。

## 6. リスクと対策
| リスク | 対策 |
|---|---|
| 鮮度(stale) | クロール間隔で更新＋hash 変更検知。UI に「N日前時点」表記(D-07整合) |
| 未クロールページ | オンデマンドを**稀なフォールバック**として残す(完全廃止しない) |
| ストレージ | URL×viewport×版を R2 に。安価・JPEG圧縮。版は世代上限で剪定 |
| クローラー依存 | クローラー停止で鮮度劣化 → 監視＋古さバッジ |
| viewport/URL 不一致 | §4 を厳守。特に URL 正規化を events/crawler/heatmap で統一 |
| CAPTURE_VERSION bump | 全消し再撮影の嵐(既存問題)。事前生成側でも**版を上げたら背景backfill**、同期コールドにしない |

## 7. 将来の大型選択肢: DOM スナップショット再構築 (記録のみ)
rrweb 系で訪問時の DOM+CSS を記録し再生 → 画像不要・即時・**レスポンシブ/スクロール一致**（固定1280撮影のズレ問題も根治）。融合のセレクタ突合(viewport差)とも整合性が良い。大規模改修のため別企画。

## 8. 実装フェーズ(承認後)
1. crawler: content_map のスクショを heatmap R2 キー体系＋メタJSONで PUT（パリティ§4遵守）。実行は Owner インフラ。
2. heatmap route: キャッシュ/stale 優先、未在庫のみオンデマンド(既存フォールバック流用)。
3. 検証: 事前生成済ページは閲覧で**即ヒット(tier=r2-fresh)・renderゼロ**を確認。未クロールのみ 202/フォールバック。
4. URL 正規化の統一(events utm 問題)を同時に解消。

## 9. Owner 依存
クロール実行/cron は Owner インフラ。R2 書込権限。CAPTURE_VERSION 運用方針(背景backfill)合意。
