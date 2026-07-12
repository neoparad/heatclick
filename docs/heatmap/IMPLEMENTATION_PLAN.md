# ヒートマップ 改善・実装計画 (2026-07-12)

> 作成: Claude / 根拠: sol(gpt-5.6)独立レビュー + Owner実機FB9件 + 4インシデントの一次証拠
> 進め方: Bash不通のため **Claude実装 → in-session Codexレビュー(tsc/jest) → Codexデスクトップでcommit/PR/deploy**
> 関連: [IMPLEMENTATION_ROADMAP_REVIEW.md](./IMPLEMENTATION_ROADMAP_REVIEW.md) (sol原文+実行ログ) / [HEATMAP_QUALITY_PLAN.md](./HEATMAP_QUALITY_PLAN.md)

---

## 0. 基本方針 — この製品の失敗は必ず「静かに」起きる

過去に潰した/発見した障害は全て「エラーを出さず、それらしく動いて見える」型だった:

| インシデント | 静かな失敗の形 |
|---|---|
| ヒートマップ2ヶ月ループ | Worker puppeteer 非互換 → 無言で Microlink 劣化 |
| cv-journey / paths | CH失敗 → 無言でダミーデータ表示 |
| install snippet tenant_id 欠落 | tracking.js が無言で全 event ドロップ |
| event-ingest 401 (10日+、過去4回の疑い) | B1副作用で無言で全 INSERT 失敗 |

**結論**: 個別バグ潰しより「静かな失敗を可視化する監視」を最優先で1本入れる方が費用対効果が高い。
本計画の Phase 0 最上位を **可観測性(observability)** とする。

---

## Phase 0: 限定公開ブロッカー (これが全部終わるまで GO しない)

### P0-α: 可観測性 — 静かな失敗の可視化 【最優先・新規】
- **なぜ最優先**: event-ingest が10日止まっても誰も気づけなかった監視の穴そのものが最大リスク。
- **P0-α1 site別 last-event freshness**: ✅ **実装完了・Codex APPROVE (2026-07-12、tsc0/jest31)**。
  - `/api/health` (既存の screenshot 経路可視化と同居) に `health.ingest` を追加。集計のみ返す
    (site_id/tracking_id/tenant_id等は一切含めない、無認証公開routeのため)。
  - 新規 `lib/monitoring/ingest-freshness.ts`: `clickinsight.sites`(registry) と
    `clickinsight.events`(is_agent=0, 90日lookback) を突合し totalSites/activeSites/staleSites/
    neverActiveSites を算出。閾値判定はSQL側で完結 (JS側でDateTimeパースしない設計)。
    env `INGEST_FRESHNESS_THRESHOLD_HOURS` (既定6時間、整数/UInt32範囲のみ有効)。
  - **2層キャッシュ + cluster-wide lock** (Codex 5往復レビューで到達): L1(in-memory)→
    L2(Redis共有,TTL60秒)→ lock取得(`SET NX EX`,TTL35秒)→ lock非取得時はL2を最大4秒poll、
    埋まらなければ「未確認」としてthrowし呼び出し元のINGEST_UNCHECKEDフォールバックに委ねる
    (自分では実クエリを実行しない=真の意味でのcluster-wide dedupe)。無認証公開routeでの
    DoS/コスト増幅リスクに対する防御。
  - 変更/新規: `lib/monitoring/ingest-freshness.ts`, `.test.ts`, `app/api/health/route.ts`,
    `app/api/health/route.test.ts` (計4ファイル、未コミット)。
  - **これがあれば10日データロスは即日検知できた**。
- **P0-α2 capture provider telemetry**: capture response に `provider/engine/cacheTier/durationMs/degradedReason` を持たせ、cold/r2-fresh/r2-stale/degraded 比率と失敗率を可視化 (sol P0-4)。
  - 変更: `lib/heatmap/r2-screenshot-cache.ts` (tier既にある), `app/api/heatmap/screenshot/route.ts`, `lib/heatmap/screenshot-provider.ts`。
  - 工数: M。
- **P0-α3 health の実capture probe**: env有無でなく安定canary URLで実Worker captureの成否・直近成功時刻・latencyを health に (sol P0-4)。
  - 工数: M。
- **DoD**: 各サイトのイベント途絶と、screenshot劣化/失敗が、人が見て/アラートで気づける。

### P0-β: Wave2 正式デプロイ 【実装済み・未リリース】
- 現状: ネガティブ位置スクロール/横ずれ根治/簡易撮影バッジの2ファイルがローカル未コミット (sol P0-1)。
- in-session Codex レビュー APPROVE 済み (tsc0/jest40)。
- 作業: `fix/heatmap-negative-scroll-and-degraded-badge` で commit/PR/merge/deploy → 本番目視。
- 変更: `components/heatmap/heatmap-canvas.tsx`, `heatmap-side-panel.tsx`。
- 工数: S(Codexデスクトップ作業のみ)。

### P0-γ: install 計測経路の恒久化 【一部済み】
- P0-2(tenant_id欠落)は PR #18 で修正済み。残:
- **P0-γ1**: snippet生成を共通関数に一本化 (現在 `/install`(proof) と `/onboarding/install`(saas-shell) の2実装が分岐。将来また片方だけ壊れる)。sol P0-2 の「共通化」。
  - 変更: 共通 `lib/install/build-snippet.ts` 新設 → 両呼び出し元を差し替え。
  - 工数: S。
- **P0-γ2**: 影響顧客(zero-ever 2件 + 直近停止4件)への再設置案内 → Owner作業(コード不要)。ただし P0-α1 freshness があれば設置状況が自動で見える。

### P0-δ: Segment の意味的整合 【sol P0-3】
- 現状: tiles/elements には segment 渡るが上部 PV/CTR/到達率(usePageStats)には未適用。new/returning 判定が「選択ページ上のsession開始」基準で、初回sessionの2ページ目訪問をreturning誤判定しうる。
- 作業: (a) page-stats にも segment 適用 (b) new/returning を visitor の site-first session 基準に修正 (c) 実CHで各segmentのsession数・分母整合を検証。
- 変更: `app/api/heatmap/page-stats/route.ts`, `lib/heatmap/segment-filter.ts`, `components/heatmap/heatmap-page.tsx`, test。
- 工数: M。

### P0-ε: 残存 red-team HIGH 2件 【sol実行時に発見】
- **P0-ε1**: `app/api/pagespeed/route.ts` = 任意URL・tenant ownershipなし・rate limitなしでGoogle API keyのquota濫用可。未使用なら削除、使うならguard追加。
  - まず参照確認 → 未使用なら B2 同様 `git rm`。工数: S。
- **P0-ε2**: `lib/heatmap/r2-screenshot-cache.ts` の cold同期capture が分散single-flight lockを取らない (stale revalidateのみlock)。並行missでWorker/CH/Microlinkのquotaを増幅。cold miss lock + tenant capture budget。
  - 変更: `r2-screenshot-cache.ts`。工数: M。

### P0-ζ: cv-journey / paths のダミー混入確認 【私の指摘・未検証】
- 両者ともCH失敗時に無言でダミー/フォールバック。本番で実データかダミーか未確認。
- 作業: Codexデスクトップで本番の `meta.dataSource` 確認 + `CV_JOURNEY_DUMMY_ONLY` env確認 + paths統計結線のmerge状態確認。
- 工数: S(調査のみ、コード不要な可能性)。

### P0-η: 感情タブの扱い 【sol P0/監査整合】
- sol指摘: 「ML準備中」を出し続けず限定公開では感情タブ自体を隠す (HEATMAP_ARCHITECTURE_SSOT.md:106-113の張り子UIパージ要求と整合)。
- 作業: 感情レイヤー/タブを限定公開時は非表示に (Phase3-Aで中身を実装したら再表示)。
- 変更: `lib/heatmap/mockup-spec.ts`, `components/heatmap/heatmap-side-panel.tsx`。工数: S。

**--- Phase 0 完了 = Owner実機目視 + 新規installからevent到着確認 + freshness健全 → 限定公開GO ---**

---

## Phase 1: 看板機能と速度 (公開後すぐ、承認不要)

### P1-A: B′-lite (既存データだけで要素アンカー) 【sol推奨: sidecarより先】
- sol発見: sidecar無しでも既存 `app/api/heatmap/elements/route.ts` が element_selector別 clicks/sessions/平均xyを集計済み、`view-model.ts:502-523` が要素CTRを表示済み。過去probeでclick全件selector有・71%text有。
- 作業: 要素ランキング + selector coverage + page-session CTR + 露出ベースCTR(`hybrid-query.ts:2021-2163`のelement_visibility_v2結合)を製品化。
- **クリック率の定義を固定** (sol): `page_session_click_rate` / `visible_session_click_rate` / `click_share` を別名でUI/API表示。下部要素はvisibility分母を優先。
- 変更: `elements/route.ts`(limit解除・rect/coverage追加), `view-model.ts`, side-panel UI。
- 工数: M〜L。**Clarityの看板機能を最小摩擦で取る**。

### P1-B: 速度 (cold capture の恒久対策) 【sol再定義】
- sol指摘: 「first-viewportを同一HTTPで返す」は現JPEG応答契約では困難(Puppeteerは1枚返してclose)。推奨順:
  1. cold miss lock + 全体deadline (P0-ε2と統合)
  2. top page × top device の非同期prewarm (直近PV上位・未capture・stale・degraded優先、tenant毎の並列数/quota制限)
  3. capture jobをqueue化しUIは202+polling or 既存provisional overlay
- **cron/prewarmは既存基盤を流用不可** (sol P0-6: 既存cronはPOST専用、Vercel CronはGET、/api/cron/*はJWT必須)。専用internal job contract(GET/POST・cron認証・tenant列挙・rate/retry/idempotency)が必要。
- 変更: `vercel.json`, 新 `app/api/cron/prewarm-screenshots/route.ts`, `r2-screenshot-cache.ts`。工数: L。

---

## Phase 2: anchor sidecar pilot (capture protocol変更、速度改善後)

- sol: DOM rect sidecarはcapture protocol/R2 contract変更なので速度より後。座標・世代整合の契約を先に定義。
- 必須契約 (sol): `CaptureAnchorManifest` (schemaVersion/captureId/capturedAt/pageUrl/device/viewportWidth/coordinateSpace='capture-css-px'/captureEngine/anchorStatus/anchors[])。
  - rectは1280正規化x/yと別に`capture-css-px`で保持(SP/TAB二重scale防止)。
  - screenshot直前の同一Puppeteer pageから採取、別crawlしない。
  - JPEG/sidecar/metadataをgeneration-specific immutable keyへ。manifestを最後にpublish、captureIdで同一世代保証。
  - clientは pageUrl+device+viewportWidth+captureId 一致時のみanchor描画。
  - `captureEngine`追加(Worker/CF RESTが現状両方provider='cloudflare')、fallbackは anchorStatus='unsupported'。
  - selector不一致(DOM挿入/子click/A-B/cookie banner)のmatched/unmatched/ambiguous coverageを計測・表示。
  - fixed/sticky/hidden/duplicate/dynamic/iframe/shadow/capped/PC-SP-TAB をfixture化。
  - selector/text/hrefはPII: sidecarはselector+geometryのみ、件数/サイズ/保持期間制限。
- **継続ゲート**: 上位click selectorのmatch率・ambiguous率・SP/PC座標誤差を先に数値化して判断。
- 工数: L(pilot)。

---

## Phase 3: 感情 (2本道)

### P3-A: 行動状態の近似 (ルールベース、名称は「感情」でなく「行動状態/フリクションシグナル」)
- sol: `hybrid-query.ts:1626-1823` に dead/rage/reversal/tab/pinch/hover-no-click 合成の frustration score が既存。
- UIは evidence_level='inferred' + confidence + sample size + 構成シグナルを並列表示。CV改善効果は断定しない。ルール出力をそのまま教師にせず weak label扱い。
- 工数: M(約1週)。D-07準拠。

### P3-B: 本物のML (独立R&D、通常roadmap外)
- ソロ運用でラベル/学習/評価/serving/drift監視を完遂は非現実的。外部LLM/APIでのラベル補助+offline評価は可。
- 開始ゲート: 同意/保持方針確定 / 人手レビュー済みラベル数・クラス分布 / holdout macro F1・calibration・abstain率 / Track A・LLM baseline超え / 低confidence時「推論不能」。

---

## 別 Go/No-Go: Wave3-C sanitized DOM下地
- 通常waveでない。現SSOTのDOMスナップ禁止と衝突 → Owner承認+privacy/security project。
- 必須: 収集/除外定義・明示consent・PII sanitization・retention/deletion/audit・DOM drift/y座標回帰fixture・screenshot方式比の定量価値検証。

---

## 横断: テスト・CI・監視の不足 (sol指摘、Phase0-1と並行)
- PRごと: `tsc --noEmit` + heatmap Jest + Worker typecheck + route integration を CI必須化 (`.github/workflows/contracts-test.yml`が現状必須実行しない)。
- nightly/canary: Worker実capture・R2 write/read・PC/SP・通常/長大ページ。
- deploy後: provider・capture duration・tier比率・失敗率・lock contention。
- E2E: page/device切替時に旧screenshot/elements/sidecarを混在させない。

---

## 実行順サマリ (推奨)

1. **P0-α1 freshness監視** (最優先・半日・再発検知の要)
2. **P0-β Wave2デプロイ** (実装済み、Codex作業のみ)
3. **P0-ζ cv-journey/paths ダミー確認** + **P0-ε1 pagespeed削除** (調査/軽量)
4. **P0-δ Segment整合** + **P0-η 感情タブ非表示** + **P0-γ1 snippet共通化**
5. **P0-ε2 cold miss lock** + **P0-α2/α3 telemetry/probe**
6. → **限定公開 GO 判定**
7. Phase1-A B′-lite → Phase1-B 速度 → Phase2 sidecar → Phase3-A 行動状態近似
8. 別途 Go/No-Go: Phase3-B ML / Wave3-C DOM

## 未確定・要判断
- cv-journey/paths が本番で実データかダミーか (P0-ζ、Codex調査待ち)
- event-ingest 過去4回の停止(5/19-,5/25-,6/6-,6/21-)が同一原因か (freshness監視が入れば以後は自動検知)
- B3(SQLi binding)が実際にmainにマージ済みか (要確認)
