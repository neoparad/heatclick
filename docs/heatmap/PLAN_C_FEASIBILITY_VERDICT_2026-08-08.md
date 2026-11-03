# Plan C (スクショ事前生成) 実現性判定 — 3-agent 実コード検証

> 2026-08-08 / 発端: オーナー質問「linkth-crawl が毎日撮影するバッチ処理があればいいのか?」
> 判定: **毎日=却下**。かつ設計書 `heatmap-screenshot-pregeneration-design.md` §3 の中核前提が **REFUTED**。
> 全主張 file:line / 実測値付き。

---

## 0. 最優先の発見 — バッチ以前に本番が無料枠で壊れている

本日の 429 の正体が確定した: **Cloudflare Workers Free 枠の「新規ブラウザ生成 1回/20秒」**。

- 実ログの成功 launch 間隔 = 28.98s / 22.89s (>20s)、429 = 10.44s / 19.32s (<20s) → しきい値に完全一致
- Paid なら 1回/秒 なので両方成功するはず → **Paid ではないと断定**
- 無料枠の他制限: browser hours **10分/日**、同時 3

**構造的な帰結**: `heatmap-canvas.tsx:392-403` の 3デバイス先読みが 4秒/8秒間隔で発火する。無料枠では**通常閲覧するだけで毎回必ず 429 になる**。バッチの有無に関係なく、今この瞬間も壊れている。

→ **Workers Paid ($5/月) が最優先**。これだけで劣化プロバイダへの降格 (画質低下) も止まる。

## 1. 「毎日」が却下される3つの理由

### 理由1: 無料枠では物理的に不可能
- 対象規模: bihadashop sitemap 実測 **183 URL** × 3デバイス = **549撮影/周**
- 1撮影 **23.92秒** (実測 23.32/24.16/24.29s) → **1周 3.65 ブラウザ時間**
- 無料枠 10分/日 = **1日25撮影** → **1周に 21.9日**。毎日どころか月1周も不可能

### 理由2: 撮り直す対象が変化していない
- sitemap lastmod 実測: **直近90日の更新 0件** (最新 2026-03-28 = 133日前)
- 毎日なら 30日で 16,470撮影・109.5時間を、内容が変わらないページに費やす
- **キャッシュを実際に壊していたのは CAPTURE_VERSION bump (31日で11回)** であってページ更新ではない

### 理由3: 体感が改善しない (TTL 設計上)
- `r2-screenshot-cache.ts:97-98` FRESH 24h / STALE 7d。**:205-215 で fresh も stale もどちらも即返し**
- 同期24秒撮影に落ちるのは **7日超過** または R2 miss のときだけ
- → 毎日は週次に対し **体感改善ゼロで browser-hours 7倍**

**コスト比較 (Paid 時)**: 毎日 109.5h/月 → **$8.95/月/サイト** / 週次 15.6h/月 → **$0.51** / 月次 3.6h/月 → **$0** (10h込み枠内)。SaaS で100サイトなら毎日は $895/月。

### 追加の罠: 日次バッチは 429 を増幅する
fresh 窓が**ちょうど 24h** なので、日次バッチだと撮影24時間1分後から必ず stale 入り → 以降の閲覧すべてが background 再撮影をスケジュール。Redis lock は `:304-306` の finally で即解放されバックオフが無いため、**429 が返っている間も閲覧のたびに叩き続ける**。バッチ間隔 < FRESH_TTL にするか FRESH_TTL 延長が必須。

## 2. 設計書 §3 の中核前提は REFUTED

> 「ugokicrawl は既に Playwright で全ページ撮影済み → 流用すれば追加コストほぼゼロ」

### 本番クロールはレンダリングしていない
- `crawler/engine.py:248` `use_playwright: bool = False` / `:252` `screenshot_enabled: bool = False` / `:189` `render_mode = "http"`
- `shared/worker_runtime.py:197-201` の本番 CrawlerEngine 構築は両者を渡さない → **aiohttp の HTTP 取得のみ**
- **「支払済みのレンダリングコスト」は存在しない**

### スクショコードはあるが、クロールの副産物ではない
- `mcp_tools/content_map.py:257` に `page.screenshot(full_page=True)` は実在 (desktop 1280 / mobile 390、`:485`)
- しかし呼び出し元はオーナー専用の手動 MCP ツール `linkscrawl_content_map_batch` のみ。顧客 API からは意図的に除外 (`mcp_api/tool_schemas.py:5`)、既定 **max_pages=50**
- celery beat (`celery_app.py:120-159`) にスクショ関連エントリ **0件**

### 画像の在庫も無い
- 保存先はローカルディスクのみ (`content_map.py:22-25`)。linkscrawl 内の R2 利用は使用量ログ転送だけ
- 2026-07-13 監査実測: DB に screenshot パス 100件あるが**本番コンテナのファイルは 0件** = 死んだ参照
- **`_screenshot_path` にビューポートが入らないため mobile が desktop を上書き** → desktop 画像はそもそも残らない

### もう一方の経路 (fetchers.py) も使えない
`fetchers.py:804` は `full_page=False` (1画面のみ)、既定 OFF、本番呼び出し元ゼロ、`screenshot_store.py:42` の **2MB cap** で超過分を黙って破棄 (実測: bihadashop の PNG 4枚中3枚が 2.28-3.93MB で該当)。

### 唯一流用できる資産
定期実行スケジューラは実装済み: `celery_app.py:139-142` + `tasks.py:112` (crawl_schedules を5分毎ディスパッチ)。**cron 基盤は再利用可・撮影処理は新規実装**。

**なお朗報**: クローラーは**ローカル Playwright** (`content_map.py:230`) で Hetzner 上で動くため、**CF の 1回/20秒・10分/日 の制約を一切受けない**。実行場所としては正しい選択。

## 3. 「そのまま置けば動く」は成立しない — writer に必要な9項目

R2 キー = `heatmap-screenshots/{ver}/{tenantId}/{siteId}/{device}/{sha256(pageUrl)[0:32]}/{ver}.jpg`

1. **ugokimap の tenantId/siteId** をクローラージョブに渡す対応表 (クローラー側 ID とは別物)
2. 撮影対象 URL は **ClickHouse events.url から query/fragment を切ったバイト完全一致文字列** (`canonical-url.ts:28-30`)。実測でホスト大文字・末尾スラッシュ差は全て別キーになる
3. **lazy 昇格 + autoScroll + naturalWidth>0 待ち** を `worker.ts:249-338` と等価に実装 ← **最大のギャップ**。content_map は networkidle+1秒待ちのみで lazy 対策ゼロ。ugokimap が v4→v12 の7回 bump で潰してきた「下部が空白」不具合を再導入する
4. 面積上限 26,000,000px 超は上端 clip し `capped`/`fullPageCssHeight` をメタに載せる
5. **JPEG q75 に変換** (クローラーは PNG。表示は壊れないが転送量で事前生成の意味が相殺される)
6. メタJSON に **`provider: 'cloudflare'` 完全一致** ← 設計書に記載なし。他の値は microlink 扱いになり **fresh 窓 24h→1h**、閲覧のたびに SWR 再撮影 = 429 増幅
7. `captureVersion` / 正しい `viewportWidth`/`naturalWidth`/`naturalHeight`/`capturedAt`
8. 画像 → メタの順で PUT
9. **tab(820) はクローラーに存在しない** → 3デバイス中2が事前生成の上限、tab は常時オンデマンド

### パリティ崩れは「無言」で失敗する
- **[A] キー不一致** → `readFromR2` が null → 例外もログもなく同期撮影 (今日と同じ24秒)。**誰も気づけない**。監視は `tier` ラベルの r2-fresh 比率のみ
- **[B] メタ寸法欠落** → `:525-527` が `naturalHeight = viewportWidth*2` に既定値フォールバック → `view-model.ts:112` の outlier ガードが深い位置のクリックを全破棄 → **「データはあるのに空表示」** (既知の最悪症状)
- **[C] capped 未記載** → scroll/exit レイヤーが最下部を描画しない

### 設計書の誤り (実装指示に使う前に訂正必須)
- **DPR=1 は必須ではない**。必要なのは「メタ寸法と実画像 px の一致」(`computePageCssHeight` が DPR を割り戻す)
- `imageContentType` は read 経路で未使用 = 座標計算に無関係
- URL正規化の記述は**結論が古い** (`canonicalizePageUrl` はデッドコード)
- §4 の行番号は 7項目中 4項目がズレている

## 4. CAPTURE_VERSION が事前生成の最大の敵

- bump はキーのパス(2箇所) + メタ照合の**二重ゲート**で、事前生成物を 1バイトも再利用させない → 全ページ全デバイスが同期24秒に逆戻り
- **旧世代を消す処理もライフサイクル設定もリポジトリに存在しない** (`r2-signed-url.ts` に DELETE 系なし) → bump のたびにゴミが永久堆積 (設計書§6「世代上限で剪定」は未実装)
- deploy と backfill の順序が守られないと bump 直後に全ユーザーが同期撮影に殺到 → 429 確定
- **L1 memory キャッシュには版が含まれない** (`screenshot-provider.ts:286`) → bump 後も最大1時間、旧画像が tier=l1 で返る (backfill 完了判定を誤らせる)

## 5. 推奨する実行順

| 順 | 内容 | コスト | 効果 |
|---|---|---|---|
| **1** | **Workers Paid 化** | $5/月 | 通常閲覧の 429 と画質劣化が止まる。バッチ以前の前提 |
| 2 | 初回バックフィル 1周 | 3.65h = **$0** (10h込み枠内) | 既存ページの初回24秒が消える |
| 3 | **変更ページのみ**再撮影 (クローラーの text_hash/asset_hash をトリガ、`content_map.py:281-284`) | 実測 churn 0件/90日 → ほぼ$0 | 定常運用 |
| 4 | CAPTURE_VERSION bump 時の背景 backfill をデプロイゲート化 | — | 唯一の大量再撮影イベントを制御 |
| 保険 | 7日以内に1周 (週次) | $0.51/月 | STALE_TTL 超過を防ぐ |

**却下**: 毎日全ページ (無料枠で不可能・Paid でも17.5倍コスト・churn 0件で無意味・fresh窓24hと衝突して429増幅)

## 6. 補足: 本日の tier=l1 0.36秒 の内訳訂正

`tier=l1` は R2 ではなく**プロセス内メモリ**キャッシュ (`r2-screenshot-cache.ts:196-203`)。同一 serverless インスタンスでしか効かない。かつ 359.6ms の内訳は **auth 0.4ms + own-ch 357.7ms + cache 1.1ms** = **99% が ClickHouse の ownership クエリ**であって画像取得ではない。当該ログ窓に `tier=r2-fresh` は1件も出ておらず、**R2 経由のヒットはまだ実証されていない** (R2 PUT 成功は確認済み)。次回計測で r2-fresh を確認する必要がある。
