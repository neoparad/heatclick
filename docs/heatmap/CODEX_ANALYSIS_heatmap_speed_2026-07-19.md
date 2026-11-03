# Heatmap 10-12秒表示速度 独立調査

調査日: 2026-07-19 (Asia/Tokyo)
対象: 'ugokimap-saas' の本番相当コード、ClickHouse tunnel、既存 '.next' 成果物
方針: read-only。コード変更、stage、commit、deployは実施していない。

## 結論

総合判定は **ADJUST**。v2文書の主因の方向性は概ね正しいが、初回表示の時間を
直列合算している点と、ClickHouse SELECT本数の数え方に修正が必要である。

コード上の実際の初回表示モデルは次の形になる。

~~~text
visual completion ~= SSR gate + client chunk/mount + max(tiles, screenshot warm) + decode/render
full UI completion ~= SSR gate + client chunk/mount + max(tiles, screenshot warm, elements)
~~~

'elements' は5クエリを直列実行するが、canvasの主要fetchとは別hookで、初回canvas表示の
必須待ちではない。したがって v2 の 'A+B+C+D = 8-13秒' は、実測根拠ではなく、並列区間を
過大に足し合わせた推定である。Ownerの10-12秒という観測自体は、tilesまたはscreenshotの
どちらかが長い場合には十分成立し得るが、現時点では区間別の実測で裏付けられていない。

## 1. v2レビュー

| v2の主張 | 判定 | 一次証拠とコメント |
|---|---|---|
| SSRがページ一覧取得を待ってからHTMLを返す | CONFIRMED | app/(proof)/heatmap/page.tsx:21-24 は clientを ssr:false でdynamic importし、page.tsx:59-62 は fetchPages(siteId) 完了後にrenderする。lib/pages/fetch-pages.ts:81,86-114 はCH queryを実行する。 |
| client mount後に4系統が並列開始する | CONFIRMED | components/heatmap/heatmap-page.tsx:126-146 でtiles、page-stats、elementsをhookとして初期化。components/heatmap/heatmap-canvas.tsx:370-418 でscreenshot fetchを独立effectから開始する。 |
| tilesの初回px取得はhappy pathで1 HTTP query | PARTIALLY CONFIRMED | app/api/heatmap/route.ts:217-248 のall-bands経路は1回のHTTP handler queryで返す。ただし route.ts:470-490 はclick系で同じWHEREをpass1/pass2の2箇所で読み、内部的には2スキャンである。失敗時はper-band fallbackへ落ちる。 |
| elementsは5クエリ直列 | CONFIRMED | app/api/heatmap/elements/route.ts:148,180,226,268,317 の順にawaitされる。image_visibilityとpage_issuesは個別catchで空配列へdegradeする。 |
| warm screenshotでもCH ownership checkがある | CONFIRMED | app/api/heatmap/screenshot/route.ts:62-86 のtenantTracksUrlがeventsを1回照会し、route.ts:145-163で所有権を確認する。 |
| R2 imageは署名URLでブラウザが直接取得する | CONFIRMED | lib/heatmap/r2-screenshot-cache.ts のmetadata/image read経路、およびv2記載のpresigned URL。アプリの画像proxyが主経路ではない。 |
| coldは本番でMicrolinkが主経路 | REFUTED | lib/heatmap/screenshot-provider.ts:498-503,941-950 のprovider優先順はWorker、Cloudflare BR、Microlink fallback。 |
| 初回はCH SELECT 8本 | ADJUST | コードで数えると、SSR pages 1、tiles 1、page-stats 1、elements 5、screenshot ownership 1で **9本**。4系統の並列性を含めると、単純な「起動5 function / SELECT 8本」という表現は不正確。 |
| 視覚完成はA+B+C+Dの直列合算 | ADJUST | tiles/page-stats/elements/screenshotはmount後に独立して発火するため、主要な視覚完成は'A+B+max(C,D)'に近い。Eはcanvasの初回表示をブロックしない。 |
| presigned R2はCDN改善余地がある | PLAUSIBLE / UNMEASURED | r2.cloudflarestorage.comへのsigned GETは確認できるが、実画像サイズ、転送時間、cache hit率は今回の資格情報では測定できなかった。 |

### 10-12秒推定の扱い

v2のA〜Eのレンジは計測前推定であり、そのまま「根因の実測内訳」とは扱えない。
特にCとDは並列区間なので、両方を加算するのは保守的な上限にもなっていない。
'max(C,D)'の片方が8秒級の長尾であれば10-12秒は説明できるが、現在の証拠だけでは
tiles、screenshot、SSR、chunkのどれが支配的かは確定できない。

## 2. 実測結果

### 2.1 ClickHouse query_log

対象はClickHouse tunnel 'https://ch.bihadashop.jp'、read-only SELECTのみ。

'analytics_reader'での'system.query_log'参照は拒否された。

~~~text
analytics_reader: Not enough privileges. To execute this query,
it's necessary to have the grant SELECT for at least one column on system.query_log.
~~~

調査用に、既知のローカル '.env.local' のdefault資格情報を使ってSELECTだけを実施した。
秘密値は出力・記録していない。2026-07-19実行結果は以下のとおり。

~~~sql
SELECT
  min(event_time) AS first_event,
  max(event_time) AS last_event,
  count() AS rows,
  countIf(type = 'QueryFinish' AND query_kind = 'Select') AS select_finished,
  countIf(type = 'QueryFinish' AND query_kind = 'Select'
          AND position(lower(query), 'clickinsight.events') > 0) AS events_select_finished
FROM system.query_log
WHERE event_time >= now() - INTERVAL 14 DAY;
~~~

結果:

~~~text
first_event=2026-07-18 00:00:00
last_event=2026-07-18 23:30:04
rows=150517
select_finished=5329
events_select_finished=6
~~~

eventsを含むSELECT 6件は、health/診断用のクエリと今回の調査クエリであり、
heatmapの本番リクエストと識別できるものは無かった。したがって、今回のquery_logから
heatmapのp50/p95/max、read_rows、read_bytes、result_bytesを算出することはできない。
query_logに見えたevents SELECTの最大例はfreshness health系で、718ms / read_rows
21,432,170 / read_bytes 707,258,149 / result_bytes 1,000だった。これはheatmap query
ではないため、heatmapの性能値として採用していない。

実運用で必要なSQLは次の形で、heatmap専用のquery_idまたはコメントを付けて識別できる
状態にしてから実行すべきである。

~~~sql
SELECT
  quantile(0.50)(query_duration_ms) AS p50_ms,
  quantile(0.95)(query_duration_ms) AS p95_ms,
  max(query_duration_ms) AS max_ms,
  quantile(0.50)(read_rows) AS p50_rows,
  quantile(0.95)(read_rows) AS p95_rows,
  quantile(0.50)(read_bytes) AS p50_bytes,
  quantile(0.95)(read_bytes) AS p95_bytes,
  quantile(0.50)(result_bytes) AS p50_result_bytes,
  quantile(0.95)(result_bytes) AS p95_result_bytes
FROM system.query_log
WHERE type = 'QueryFinish'
  AND query_kind = 'Select'
  AND event_time >= now() - INTERVAL 1 DAY
  AND position(query, 'heatmap-query-id') > 0;
~~~

### 2.2 Tunnel RTT

'analytics_reader'で'SELECT 1'を3回、同じtunnelへ実行した結果:

| sample | total |
|---:|---:|
| 1 | 327.23 ms |
| 2 | 247.59 ms |
| 3 | 248.54 ms |

中央値は約248.54ms、範囲は247.59-327.23ms。これは調査元PCからCloudflare Tunnelまでの
RTTであり、Vercel FunctionからのRTTではない。elements 5直列の通信下限を単純化すると
約1.24-1.64秒だが、CH実行時間、接続再利用、Vercel位置差を含まない下限評価である。

### 2.3 R2 metadata/image

ローカル '.env.local' の以下のキーは全て未設定だった。

~~~text
R2_ACCOUNT_ID=False
R2_ACCESS_KEY_ID=False
R2_SECRET_ACCESS_KEY=False
R2_BUCKET=False
~~~

また、現在のlocal Wranglerの'wrangler r2 object'にはlistコマンドがなく、get/put/delete
のみだった。よって'heatmap-screenshots/v12/'のオブジェクト一覧、metadataのJSONサイズ、
JPEGサイズ、signed GETの実転送時間は測定していない。ここはR2 Operator権限または
Cloudflare側のobject metricsが必要である。

### 2.4 本番endpoint

認証cookieをこの調査環境では取得していないため、認証済みheatmap APIの測定は未実施。
認証なしの1回だけ、測定用のURLに対して実行した結果は以下。

~~~text
GET /api/heatmap?... -> 401
TTFB 0.102873s / total 0.102926s
~~~

これはauth gateの応答時間であり、heatmap実データの性能値ではない。'/api/health'の
約3.26秒もhealth側のfreshness checkを含むため、heatmapの代替値として扱っていない。

### 2.5 Next build/chunk artifact

buildを再実行せず、既存の'.next' artifact（最終更新 2026-07-12）をread-onlyで集計した。
heatmap routeのmanifestに含まれるファイルとbyte数は以下。

| chunk | bytes |
|---|---:|
| webpack | 4,184 |
| fd9d1056 | 173,179 |
| 5652 | 319,308 |
| main-app | 3,328 |
| 8014 | 22,392 |
| 8865 | 7,932 |
| heatmap page chunk | 98,318 |
| **manifest合計** | **628,641** |

これは圧縮前の既存成果物サイズであり、現行ソースの再build結果、gzip/brotli転送量、
parse/hydrate時間ではない。route専用chunk単体は約98KBで、chunk取得だけで10秒を説明する
証拠にはならないが、chunk/shared/hydrationを含むB区間の実測は残っている。

## 3. 独自の帰属評価

### A: SSR gate

**確度: 高（構造確認、時間未計測）**。'ssr:false'のためHeatmapPage本体はHTML生成に
参加せず、'fetchPages'のCH query完了後に初めてclient mountへ進む。'fetchPagesCached'は
5分cacheなので、cache miss、deploy直後、cache key違いでここが毎回効く可能性がある。

### B: client chunk/mount

**確度: 中（artifact確認、実時間未計測）**。既存route manifest合計628,641 bytes、専用chunk
98,318 bytes。これは有意な起動コスト候補だが、圧縮転送と実端末parse時間が無いため、
10-12秒の主因とはまだ言えない。

### C: tiles CH query

**確度: 高（コード上の高負荷候補、実時間未計測）**。click系all-bandsは1 HTTP request
だが、2-passでeventsを2回読む。WHEREにはtenant/site、canonical URL、event_type、
is_agent、期間、device、segment条件が入り、正規化URLの計算もある。UIは'tile_size: 6000'
で初回に全域を取りに行く設計である。ここは初回canvas表示の最有力なサーバ側候補だが、
query_log上でheatmap SELECTとして観測できていない。

### D: screenshot warm chain

**確度: 中（構造確認、サイズ/時間未計測）**。warmでもownershipのCH queryが1回あり、
R2 metadataの後にsigned image URLをブラウザへ返す。画像はR2 originから直接取得するため、
full-page JPEGが大きい場合はtransfer/decodeが長尾になり得る。ただしR2 object sizeと
実転送時間を得ていないため、Cより大きいとは断定しない。

### E: elements 5直列

**確度: 高（構造確認、canvas非ブロック）**。5クエリ直列で、測定したtunnel RTTだけでも
複数秒の下限要因になり得る。ただし主要canvasのtiles/screenshotと別hookであり、初回の
ヒートマップ描画より「サイドパネルを含む全UI完了」に効く区間である。

## 4. 優先度付き提案

### P0: まず帰属できる観測を追加

query_logにheatmap requestを識別できるquery_id/コメントが無いため、まず各APIの
Server-Timingまたは構造化ログに次を追加する。

1. SSR pages query
2. tiles CH query（handler時間、CH query時間、read rows/bytes）
3. page-stats
4. screenshot ownership、R2 metadata、capture cold/warm、image bytes
5. elements各queryの個別時間と合計
6. browser側のmount、各fetch開始/終了、image decode完了

'system.query_log'権限を本番アプリのdefaultへ戻すのではなく、限定されたobservability
用roleまたはサーバ側集計へ分離する。現状の権限境界のままではquery_log p50/p95を継続監視できない。

### P1: tilesのcache/queryを計測後に短縮

初回視覚完成に直結し、2-pass events scanも確認できるため最優先候補。短TTLのserver
cache、canonical pathnameの事前正規化列、pass1/pass2の再設計を候補にする。意味のある
top-500制限とsession数の品質を保持したまま、query_logでread bytesとp95を比較する。

### P1: screenshot配信の実サイズとcacheを確認

R2 object size、TTFB、download、decodeを測り、full-page JPEGが支配的ならcustom domain
やedge cacheなどを検討する。private objectの認可要件を壊さず、署名URLのTTLとcache keyを
設計してから変更する。

### P1: elementsの5直列をPromise.all化

canvas初回表示を変えずに全UI完了を短くできる、低リスクの改善候補。'image_visibility'
や'page_issues'の権限/障害時degradeを維持し、各queryの独立性をテストしてから並列化する。

### P2: ownership結果の短TTL cache

screenshot routeだけのCH ownership queryを短TTL化できればwarm chainを短縮できる。ただし
tenant/site/page ownershipの認可境界をcache keyに含め、cross-tenant reuseを防ぐ必要がある。

### P2: SSR gateのstreaming/client fetch化

HTML/placeholderを先に返せるが、最初の実データ表示時間を必ず短くする施策ではない。
認証、site ownership、初期page選択のUXを含む変更なので、P0観測後に判断する。

### P2: cold captureのdedupeと再撮影保証

これは10-12秒のwarm仮説とは別の長尾対策。同期cold captureの重複排除、v12 bump時の
再撮影負荷、background revalidateの完了保証を、別のcaptureメトリクスで追う。

## 5. 未確認項目と次の測定

- heatmap専用CH queryのp50/p95/max、read rows、read bytes、result bytes: query_logの識別子または限定roleが必要。
- R2 v12 metadata/JPEGサイズとsigned GET転送時間: R2 credentials/metricsが必要。
- Vercel実行環境からtunnelへのRTT: Vercel側Server-TimingまたはFunctionログが必要。
- 認証済み本番heatmapの実測: Ownerの検証用session/cookieまたはPreviewの認証可能な環境が必要。
- '.next'は既存artifactのため、現行sourceと同一commitでの再build結果ではない。

以上により、v2は「調査すべき構造」を正しく絞れているが、次の実装はまず計測を入れ、
'A+B+max(C,D)'の実測内訳を作ってからtiles、screenshot、elementsの順に着手するのが妥当である。

