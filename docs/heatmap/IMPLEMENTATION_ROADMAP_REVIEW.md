# ヒートマップ 今後の実装ロードマップ 独立レビュー

更新日: 2026-07-11  
対象: `ugokimap-saas` / `neoparad/heatclick`  
レビュー方式: シニアエンジニア・プロダクト・運用の3視点、read-only一次証拠確認

## 総合判定

**ADJUST**

B'（要素アンカー）の顧客価値は高い。ただし、現状の「sidecarをPhase1で一気に実装し、その後に速度改善」という単位では工数とリスクを過小評価している。

以下のように分割する。

1. 限定公開前のPhase0を拡張し、deploy・install・Segment・security・capture運用を修正する。
2. 既存データで実現できるB'-liteを先行する。
3. capture速度・prewarmを改善する。
4. DOM rect sidecarは座標・世代整合の契約を定義してからpilotする。
5. 感情は「行動状態の近似」と本物MLを別プロジェクトとして扱う。

## 最優先の一次証拠

### P0-1: Wave2はGit/Vercel上では未リリース

- GitHubの最新mergeはPR #17 Wave1、merge commit `318d30f`。
- `origin/main`も`318d30f`。
- Vercelの最新Productionは2026-07-04作成、Wave1時点。
- Wave2相当の差分は現在ローカルの次の2ファイルに未コミットで存在する。
  - `components/heatmap/heatmap-canvas.tsx`
  - `components/heatmap/heatmap-side-panel.tsx`
- この2ファイルはユーザー作業として保護し、勝手に破棄・上書きしないこと。

対応: Wave2を正式branch/PR/merge/deployし、本番でネガティブ位置スクロール・横ずれ根治・簡易撮影バッジを確認する。

### P0-2: 現行 `/install` snippetはv2計測を停止させる

- `components/install/install-settings-pane.tsx:436-446` は `CLICKINSIGHT_SITE_ID` だけを出力する。
- `public/v2/tracking.js:133-136` は `tenant_id` 未設定時にイベント送信を停止する。
- `app/(saas-shell)/onboarding/install/tracking-snippet.tsx:132-148` の別snippetは `data-tenant-id` を含み正しい。

対応: 正しいsnippet生成を共通関数へ一本化し、`site_id + tenant_id + install_token`を必須化する。生成snippetを実ブラウザへ設置し、新規event到着までをE2E/実機で確認する。限定公開GOブロッカー。

### P0-3: Segmentは結線済みだが意味的に不整合

- tiles/elementsにはsegmentが渡る: `components/heatmap/heatmap-page.tsx:108-146`。
- 上部PV/CTR/到達率の`usePageStats`にはsegmentが渡っていない。
- `lib/heatmap/segment-filter.ts:35-59` のnew/returning判定は、visitor初回来訪と「選択ページ上のsession開始」を比較する。同じ初回sessionで2ページ目へ進むとreturning扱いされ得る。
- 現行テストはSQL文字列の形を検査するだけで、複数ページを含むsession semanticsを検証していない。

対応: page statsにもsegmentを適用する。new/returningはvisitorのsite-first session_id、またはsession全体の開始時刻を基準にする。実CHで各segmentのsession数、tiles、elements、statsの分母整合を確認する。

### P0-4: Screenshot障害の再発検知とstampede防止が不足

- `app/api/health/route.ts:27-38` はWorker envの有無だけでexpected providerを決め、実capture成功を確認しない。
- `lib/heatmap/r2-screenshot-cache.ts:188-210` はR2 read失敗をmiss扱いし、cold同期captureへ進む。
- cold missでは分散lockを取得せず、lockはstale revalidateだけで使われる。
- `app/api/heatmap/screenshot/route.ts:42-44` のroute上限は90秒。
- providerはWorker 60秒、Cloudflare REST 30秒、Microlink 25秒、CDN 20秒を逐次実行し得る。
- UIは `components/heatmap/heatmap-canvas.tsx:842-874` で「最大30秒」と表示する。

対応:

- 安定したcanary URLを使う実Worker capture probe、直近成功時刻、provider、latencyを監視する。
- capture responseに`provider / engine / cacheTier / durationMs / degradedReason`を持たせる。
- cold missにもtenant/site/device/url単位の分散lockを適用する。
- provider chain全体のdeadlineを定め、各providerの残予算を配分する。
- 実SLOと一致するまで「最大30秒」の断定を修正する。

### P0-5: 限定公開前のsecurity項目

- `app/api/proxy-page/route.ts:31-79` は初期hostnameだけ検証し、`redirect: 'follow'`で取得したHTMLを返す。redirect/DNS rebinding経由のSSRF余地がある。
- `app/api/screenshot/route.ts` は旧ScreenshotOne endpointで、site ownership・route固有rate limitがない。

対応: 未使用なら両routeを削除。必要なら共通SSRF guard、redirect手動追跡、各hop再検証、tenant-owned URL制約、rate limitを適用する。

### P0-6: cron/prewarm基盤はそのまま再利用できない

- `vercel.json`はdaily summary/deep research/fusion ingestをcron登録している。
- 各routeの処理はPOSTのみで、GETは405または未定義。
- `/api/cron/*`は`middleware.ts:132-179`のpublic allowlist外でJWT認証へ流れる。
- Vercel CronのGETでは現在の処理を起動できない。
- interactive screenshot routeはuser session、site membership、直近30日のURL ownershipを要求するため、prewarm cronから直接呼ぶ契約ではない。

対応: prewarmは専用internal job contractを作る。GET/POST、cron認証、tenant/site列挙、rate control、retry、idempotencyを明示する。

## B' 要素アンカーの評価

### すでに存在する価値

- `app/api/heatmap/elements/route.ts:147-177` は`element_selector`別にclicks、sessions、平均x/yを集計する。
- `lib/heatmap/view-model.ts:502-523` は `element sessions / page sessions` のクリック率を表示する。
- 過去probeではclick 649件の全件にselector、71%にtextが存在するとのコードコメントがある。
- `lib/llm/hybrid-query.ts:2021-2163` には`element_visibility_v2`とclickを結合する露出ベースCTRもある。

結論: sidecarなしでも、要素ランキング・page-session CTR・selector coverage・露出ベースCTRをB'-liteとして短期間で製品化できる。

### クリック率の定義を固定する

混同しないよう、UI/APIで次を別名にする。

- `page_session_click_rate`: 要素をクリックしたunique session / ページsession。
- `visible_session_click_rate`: 要素を見たunique sessionのうちクリックしたsession。
- `click_share`: ページ全clickのうち当該要素へのclick割合。

下部要素ではpage sessionを分母にすると不当に低くなるため、顧客が期待する「要素CTR」はvisibility分母を優先する。既存`executeCtaFunnelQuery`はraw impression count近似なので、可能ならunique session結合へ改善し、近似の場合はevidenceを明記する。

### sidecarの必須契約

CHのevents/elementsを数値の正本、sidecarを「現在capture上のgeometry」に限定する。

必須フィールド例:

```ts
interface CaptureAnchorManifest {
  schemaVersion: 1
  captureId: string
  capturedAt: string
  pageUrl: string
  device: 'pc' | 'sp' | 'tab'
  viewportWidth: number
  coordinateSpace: 'capture-css-px'
  captureEngine: 'puppeteer-worker' | 'cloudflare-rest' | 'microlink'
  anchorStatus: 'complete' | 'partial' | 'unsupported'
  anchors: Array<{
    selector: string
    rect: { x: number; y: number; width: number; height: number }
    matchCount: number
    state: 'matched' | 'ambiguous'
    position: 'normal' | 'fixed' | 'sticky'
  }>
}
```

実装条件:

- rectは既存の1280正規化`x/y`に入れず、`capture-css-px`として別保持する。SP/TABで二重scaleしない。
- screenshot直前の同一Puppeteer pageからrectを採取する。別requestで再crawlしない。
- JPEG、anchor sidecar、metadataをgeneration-specific immutable keyへ保存する。
- manifestを最後にpublishし、hash/captureIdで同一世代を保証する。
- clientは`pageUrl + device + viewportWidth + captureId`一致時だけanchorを描画する。
- WorkerとCloudflare RESTは現在どちらも`provider='cloudflare'`なので、`captureEngine`を追加する。
- fallback providerは`anchorStatus='unsupported'`とする。
- tracker selectorは最大5階層、`nth-child`依存。DOM挿入、子要素click、A/B variant、cookie bannerで不一致になるため、matched/unmatched/ambiguous coverageを表示・計測する。
- fixed/sticky、hidden、duplicate selector、dynamic element、iframe/shadow DOM、capped page、PC/SP/TABをfixture化する。
- selector/text/hrefはPIIになり得る。sidecarは原則selector+geometryのみ、件数・サイズ・保持期間を制限する。

### B'と速度の順序

- B'-liteは既存データの仕上げなので速度より先でよい。
- DOM rect sidecarはcapture protocol/R2 contract変更なので速度より後にする。
- sidecar pilotの継続条件は、上位click selectorのmatch率、ambiguous率、SP/PC座標誤差を先に数値化して決める。

## 速度改善の再定義

「first viewportを同じHTTP requestで返し、その後full captureを完成させる」は現在のbinary JPEG response契約では実現しにくい。PuppeteerはautoScrollと画像待機の後に1枚のJPEGを返し、browserをcloseする。

推奨順:

1. cold miss lockと全体deadline。
2. top page × top deviceの非同期prewarm。
3. capture jobをqueue化し、UIは`202 + job status polling`または既存provisional overlayを使う。
4. それでも必要なら、first viewport thumbnailとfull captureを別artifactとして設計する。

prewarm対象は全URLではなく、直近PV上位、未capture、stale、provider degradedを優先する。1 tenant/siteあたりの並列数とWorker quotaを制限する。

## 感情機能

### Track A

約1週の実装は現実的。ただし初期名称は「感情」ではなく「行動状態の近似」または「フリクションシグナル」とする。

- `lib/llm/hybrid-query.ts:1626-1823` にdead/rage/reversal/tab/pinch/hover-no-clickを合成するfrustration scoreがすでにある。
- UIは`evidence_level='inferred'`、confidence、sample size、構成シグナルを並列表示する。
- CV改善効果を断定しない。
- ルール出力をそのまま教師データにしない。weak labelとして人手QA・outcomeと組み合わせる。

### Track B

ソロ運用で、ラベル作成・学習・評価・model serving・drift監視までを通常feature roadmap内で完遂するのは非現実的。外部LLM/APIによるラベル補助とoffline評価は可能だが、独立R&Dとして扱う。

開始ゲート例:

- 同意・保持方針が確定。
- 人手レビュー済みラベル数とクラス分布が基準を満たす。
- holdoutでmacro F1、calibration、abstain率を測定。
- Track A/LLM baselineを明確に上回る。
- 低confidence時は「推論不能」とする。

限定公開では「ML準備中」を表示し続けず、感情タブ自体を隠す。`docs/heatmap/HEATMAP_ARCHITECTURE_SSOT.md:106-113`も張り子UIのパージを要求している。

## Wave3-C sanitized DOM

通常の後続waveとして扱わない。現SSOTのDOM snapshot禁止と衝突するため、Owner承認を伴う別architecture/privacy projectとする。

最低限必要:

- 収集対象と除外対象の定義。
- 明示consentとtenant設定。
- text/input/attribute/URLのPII sanitization。
- retention、deletion、audit。
- DOM driftとy座標回帰のfixture/E2E。
- screenshot方式に対する定量的な価値検証。

## テスト・監視の不足

- `tests/e2e/heatmap-screenshot.spec.ts`はAPI mock中心で、token未設定時skip。
- P2/P3の実Worker、R2、capped、cold/warm、provider fallbackを本番同等経路で継続検証していない。
- `.github/workflows/contracts-test.yml`はrootの`tsc`、Jest、Playwrightを必須実行しない。
- healthは実Worker/R2/cache tierを検証しない。

追加ゲート:

- PRごと: `npx tsc --noEmit`、heatmap Jest、Worker typecheck、route integration tests。
- nightly/canary: Worker実capture、R2 write/read、PC/SP、通常/長大ページ。
- deploy後: provider、capture duration、cold/r2-fresh/r2-stale/degraded比率、失敗率、lock contention。
- E2E: page/device切替時に旧screenshot・elements・sidecarを混在させない。

## 修正版ロードマップ

### Phase0-A: 限定公開ブロッカー

Wave2正式deploy、install snippet、Segment semantics/stats、proxy/screenshot legacy route閉鎖。

### Phase0-B: capture運用

実Worker canary、cache/provider telemetry、cold miss lock、deadline、P2/P3本番同等E2E。

ここまで完了し、Owner実機目視・Segment実データ・新規installからevent到着を確認して限定公開GO。

### Phase1-A: B'-lite

既存elements集計、selector coverage、page-session CTR、visibility CTR、ランキングを製品化。

### Phase1-B: 速度

専用internal job/queue、top page prewarm、retry/idempotency/quota制御。

### Phase2: anchor sidecar pilot

coordinate contract、captureId、atomic manifest、provider capabilityを実装し、限定ページでmatch率を評価。

### Phase3-A: inferred behavior states

D-07準拠の行動状態近似。感情断定を避け、根拠シグナルを並列表示。

### Phase3-B: ML R&D

ラベル・評価・コスト・servingの各ゲートを満たした場合のみ開始。

### Separate Go/No-Go: Wave3-C

SSOT改定、privacy/security review、Owner承認後のみ着手。

## 実行結果 2026-07-12

### P0-2 tracking snippet tenant_id欠落

- PR: https://github.com/neoparad/heatclick/pull/18
- branch commit: `3611e377ece25e7c9cf5977045c915c778b6737c`
- main merge commit: `01faba673e779175929a04f5243f8e5f8fa22eb4`
- 検証: `npx tsc --noEmit` EXIT 0、GitHub CI green、Vercel Preview green。
- Production deployment: `dpl_3qGiHhMkSv9p1J7YdKCguEk2YcgZ` Ready。
- Production `/api/health`: HTTP 200、ClickHouse healthy、expected screenshot provider=worker。

Supabase `tenant_sites` 6件とClickHouse `events`を照合した結果:

| site_id | total | 30d | 7d | last event | 判定 |
|---|---:|---:|---:|---|---|
| `CIP_E3xzSWfXcXx6GaTL` | 0 | 0 | 0 | なし | **zero ever。link-th.co.jp provision由来で再設置案内最優先** |
| `CIP_xginf3nVacnkn62o` | 0 | 0 | 0 | なし | **zero ever。未設置か壊れたsnippetの可能性** |
| `CIP_6r2WofQDSKrOwxmM` | 68,891 | 9,657 | 0 | 2026-07-01 23:23:30 | 直近停止、設置状況確認 |
| `CIP_8eN7xgfBtDAnzE26` | 3,285,078 | 1,712,758 | 0 | 2026-07-02 01:04:10 | 直近停止、設置状況確認 |
| `CIP_EcwUTHEZdIOAUqum` | 11,127,917 | 1,570,107 | 0 | 2026-07-02 01:01:12 | 直近停止、設置状況確認 |
| `CIP_QWaPiks5krukJ6NM` | 9,647,334 | 5,119,882 | 0 | 2026-07-02 01:04:12 | 直近停止、設置状況確認 |

Owner対応: zero-ever 2サイトへ新snippetの再設置案内。残り4サイトも全て直近7日0件なので、タグ残存・GTM publish・ingest到達を確認する。

Security review補足: browser telemetryのsite/tenant IDは公開routing identifierであり秘密ではない。現在のingestはsite registryとのpair一致を検証しcross-tenant mismatchを拒否する。一方、公開browser telemetryの偽造・spam耐性は別問題として残る。外部multi-tenant公開前にdynamic authorized site一覧、per-site/IP rate limit、anomaly detectionを実装する。

### B2 未使用legacy endpoint削除

- PR: https://github.com/neoparad/heatclick/pull/19
- branch commit: `c710d57ecb57b26fbcf549bb964ebffc9b34a852`
- main merge commit: `d1f8a2238e685ca952569e9e79e9770ca3317bea`
- 削除: `app/api/proxy-page/route.ts`、`app/api/screenshot/route.ts`のみ。
- docs以外のruntime参照: 0。
- 検証: `npx tsc --noEmit` EXIT 0、`npx next build` EXIT 0、GitHub CI green、Vercel Preview green。
- Production deployment: `dpl_BxzW2QZm5EKzejg6as2PvVhDMhGZ` Ready。
- Production `/api/health`: HTTP 200。削除pathはmiddlewareで未認証401になるが、Next build route tableから消えている。
- LOW: `docs/SECURITY.md`と`docs/clickhouse-capabilities.csv`に旧`/api/proxy-page`記述が残る。今回のsecurity commitには混ぜていない。

### 今回の追加red-teamで判明した残存HIGH

1. `app/api/pagespeed/route.ts` は任意URL、tenant ownershipなし、rate limitなしでGoogle PageSpeed API keyのquotaを消費できる。現行callerが無ければ削除候補。
2. `lib/heatmap/r2-screenshot-cache.ts` のcold synchronous captureは分散single-flight lockを取らない。同一tracked URLへの並行missでScreenshot Worker/Cloudflare/Microlink quotaを増幅できる。cold miss lockとtenant capture budgetが必要。

## P0 event-ingest停止インシデント復旧 2026-07-12

- 影響: 実績サイトのClickHouse `events`が2026-07-02 01:01-01:04 UTCから一斉停止。ブラウザ側に再送キューがない期間のイベントは復元不能。
- 根因: `ugokimap-event-ingest` Workerのsecret `CLICKHOUSE_URL`がB1のClickHouse `default` password rotationに追従していなかった。
- 修正前live log: `sites lookup HTTP 401`、`default: Authentication failed: password is incorrect`。接続timeoutではなくstale credential。
- 修正: `CLICKHOUSE_URL`を`https://<redacted>@ch.bihadashop.jp`へ更新し、Cloudflare Tunnel経由へ統一。
- Worker deploy: version `b1c1d06b-5180-4c81-8ff4-4684523e283b`、2026-07-12 13:27:14 UTC、100% active。
- 検証: synthetic monitor pageview `codex-incident-recovery-1783862861879`が`events`に1件保存。修正直後の実trafficも `CIP_8eN7xgfBtDAnzE26` 123件、`CIP_EcwUTHEZdIOAUqum` 184件、`CIP_QWaPiks5krukJ6NM` 161件を確認。
- 再検証: 4実績siteへsynthetic monitor pageviewを各1件送信し、全4件が2026-07-12 13:34:49 UTCに`events`へ保存。live tailは認証/network error 0件、INSERT success 217件。
- 修正後log: `ClickHouse INSERT events: N rows`が連続し、401は解消。
- 過去の同期gap: 2026-05-19から05-22、05-25から05-28、06-06から06-07、06-21から06-22にも複数サイト同時の無event期間あり。同一原因とは未確定だが、今回が初回ではない。
- 再発防止P0: event-ingest専用writer userへ最小権限化、`flushToClickHouse` network rejectionの明示log、site別last-event freshness alert、CH credential rotation checklistへWorker secretを追加。

上記2件はPR #19の削除差分外であり、PR #19自体のsecurity/code reviewはAPPROVE。限定公開全体の残存ブロッカーとして別修正する。
