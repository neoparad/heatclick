> 作成: 2026-08-09 / 4-agent 実コード調査 (linkscrawl + ugokimap-saas 横断) に基づく設計案
> 発端: オーナー指摘「差分クロールの連携経路を作らないと意味がない」
> ステータス: **設計のみ・未実装**。着手前に §6 の未確認事項 (特に #1 と #3) の実測が必要

# UGOKI MAP ヒートマップ背景スクショ — 変更検知連携 設計案

---

## 0. 前提の訂正（設計の出発点を正しくする）

依頼文の「記事を更新しても**最大7日間**古いスクショが表示される」は、実コードと照らすと**不正確**。先にここを直さないと、案の費用対効果を誤って評価する。

`lib/heatmap/r2-screenshot-cache.ts:189-206` の実挙動：

| 経過時間 | 挙動 |
|---|---|
| 〜24h (`FRESH_TTL_MS` :75) | R2 のまま返す。再撮影なし |
| 24h〜7d (`STALE_TTL_MS` :76) | **古い画像を1回返しつつ、背景で再撮影**（SWR、:199-203 → `scheduleRevalidate` :272-308 → `storeInR2` :294 で `capturedAt` 更新） |
| 7d 超 | 同期再撮影（:209、route の `maxDuration = 90` : `app/api/heatmap/screenshot/route.ts:45`） |

つまり：

- **ユーザーが見る古い画像の上限は「24h + 閲覧1回分」**（＋L1 in-memory 最大1h。`lib/heatmap/screenshot-provider.ts:107-108`）。7日ではない。
- 一方 **「無駄な撮り直し」は依頼文より深刻**。閲覧されているページは、内容が変わっていなくても **24h ごとに 1 撮影 ×3デバイス** 走り続ける。

そしてコストは実在の制約に直結する。`app/(proof)/operator/heatmap-backfill/page.tsx:5-6` に「Workers Paid の browser hours 枠（月10h）内で」と明記があり、対象は `page.tsx:26` の「sitemap 実測 183 URL」×3デバイス = 549 撮影/全件。

**→ 本件の主目的は「古い画像を消すこと」ではなく「`FRESH_TTL` を安全に伸ばせるようにすること」**。変更検知はそのための前提条件。この読み替えが以降の判断軸。

（1撮影あたりの実 browser 秒数、および実際の日次閲覧ページ数は**未確認**。確認方法は §6。）

---

## 1. 方式比較（5案）

前提として、**どの案でも「R2 キャッシュを URL 単位で無効化する部品」は必要**（現状ゼロ：`r2-screenshot-cache.ts` の export は `getHeatmapUnderlayWithR2Cache` :160 と `buildR2Keys` :481 のみ、`force` フラグなし、DELETE 署名も作れない＝`lib/scenarios/r2-signed-url.ts` の署名器は `signR2PutUrl` :82 と `signR2GetUrl` :179 のみ）。以下は「その部品に**何が変更を教えるか**」の比較。

### (a) クローラー push（webhook）→ MAP が `/changes` を引く

linkscrawl の既存 webhook（`api/webhook_routes.py:34-47` の `ALLOWED_EVENTS` に `crawl.completed` / `crawl.changes.detected`）で MAP を叩き、MAP が受信した `job_id` で `GET /v1/crawl/{job_id}/changes?category=content_changed`（`api/crawl_alias_routes.py:105-138`）を X-API-Key で引き、変わった URL 群を得る。

| 観点 | 評価 |
|---|---|
| 実装量 | **linkscrawl 側ゼロ**（購読登録と API キー発行という運用操作のみ）。MAP 側は受信 route + HMAC 検証 + クライアント + 無効化部品 |
| 認証 | MAP 側に HMAC 検証を新規実装（`api/webhook_dispatcher.py:48-60` `verify_signature` の TS 移植、〜40行）。ただし**後述の設計により webhook payload を一切信用しない**ので、HMAC は DoS/コスト防御であって正当性の根拠ではない |
| 失敗モード | webhook 未達 → 無効化が起きない → TTL 挙動に自然フォールバック（無害）。`crawl.changes.detected` は**スケジュールクロール限定**（`shared/schedule_dispatcher.py:608-634`, `shared/celery_app.py:139-142` beat 300s）なので、手動クロールを拾うには `crawl.completed`（`shared/tasks.py:783`、全クロールで発火）も購読する必要あり |
| 運用負荷 | 低。webhook 1本登録 + API キー1本。secret ローテ API も既存（`api/webhook_routes.py:165`） |
| 既存資産再利用 | **最高**。テーブル（migration 014/026）、HMAC、1/4/16秒リトライ、SSRF guard、クロステナント修正済み fan-out（`webhook_dispatcher.py:184-197`）が全部そのまま使える |

### (b) MAP が定期 pull（cron）

MAP の cron が定期的にクローラーへ「変わったページ」を聞きに行く。

| 観点 | 評価 |
|---|---|
| 実装量 | MAP 側は (a) とほぼ同じ。**加えて「そのサイトの最新 completed job_id」を取る手段が要る** |
| 認証 | X-API-Key のみ。HMAC 不要 → (a) より単純 |
| 失敗モード | job 一覧エンドポイントの有無が**未確認**。無ければ linkscrawl 側に新規実装が必要（＝「linkscrawl 側ゼロ」の利点が消える）。`FUSION_INGEST_TARGETS` 方式（`lib/fusion/ingest.ts:230-245`）は jobId 固定で新クロールに追随しない既知の失敗設計なので流用不可 |
| 運用負荷 | 中。cron 経路の再整備が要る（`/api/cron/*` は `middleware.ts:132-140` の `API_PUBLIC_PATHS` 未登録 → `classify()` :178 で `api-tenant` → :466-479 で 401。`vercel.json:12-15` に登録済みでも到達しない） |
| 既存資産再利用 | 中。`/changes` は使えるが、job 解決が空白 |
| 遅延 | cron 間隔ぶん（6h 等）。(a) は分単位 |

### (c) 共有ストア経由（ClickHouse `clickinsight.page_content_sections`）

fusion export を復活させ、セクション単位 `text_hash`/`asset_hash`/`cta_hash` を MAP の ClickHouse に流し、MAP 側 SQL で世代間 diff を取る（`migrations/2026-06-06-ugokicrawl-fusion-clickhouse.sql:35-68`、DDL コメントに「クロール間 diff の源泉」）。

| 観点 | 評価 |
|---|---|
| 実装量 | **大**。両端とも配線が切れている：linkscrawl は `api/main.py:67,313` で import/include をコメントアウト（理由は :311-312 に「RT-06 tenant_id クエリの BOLA 懸念」＝**セキュリティ課題を解いてからでないと mount できない**）、MAP は `/api/cron/fusion-ingest` が middleware で 401 |
| 認証 | `X-Fusion-Token`（`api/fusion_routes.py:23-29`）は実装済みだが、unmount 理由の BOLA 対処が別途必要 |
| 失敗モード | **致命的な疑い**：セクションハッシュの生成元 `extract_content_map()` は Playwright 起動を伴い、呼び出し元は MCP ツール2本のみ（`mcp_tools/content_map.py:236-270`, `mcp_tools/tools.py:4039-4051,4078-4086`）。`shared/tasks.py` からの呼出はゼロ ＝ **本番自動クロールでは `page_content_map` が埋まらない**。したがって fusion で流れてくるセクション配列は**空の可能性が高い**（要検証、§6-3） |
| 運用負荷 | 高（ClickHouse 表の増加、tenant_id 規約外の `page_structure` 問題も併存：`mcp_tools/clickhouse_sync.py:147-163` に tenant_id 列なし） |
| 既存資産再利用 | 見かけ上は高いが、実データが流れないなら**ゼロ** |
| 唯一の優位 | `asset_hash` があれば**画像差し替え**も検知できる（(a) の `content_hash` は可視テキストのみなので画像変更を検知できない） |

### (d) クローラー非依存：MAP 単独の条件付き GET（ETag / Last-Modified）

SWR 再撮影の直前に対象 URL へ条件付き GET を投げ、304 なら「変わっていない」とみなして `capturedAt` だけ延命し、撮影をスキップする。

| 観点 | 評価 |
|---|---|
| 実装量 | 小〜中。MAP 内で完結、リポジトリ跨ぎゼロ |
| 認証 | 不要（既存 `validateExternalUrl` の SSRF guard を通す） |
| 失敗モード | **対象サイトが安定した ETag/Last-Modified を返すかが未確認**。WordPress は返さないことが多い。返さなければ常に「変わったかも」となり現状と同じ。また HTML の ETag は本文以外（CSRF トークン等）でも変わりうる — この問題は linkscrawl 自身が `crawler/parser.py:833-847` のコメントで「生HTMLハッシュは per-request 変動要素を含むので使えない」と結論済み |
| 運用負荷 | 最低 |
| 既存資産再利用 | 低（新規ロジック）だが**新しい依存を一切増やさない**のが最大の利点 |

### (e) 何も連携せず「選択的無効化」だけ作る（オペレータ手動 / スクリプト）

URL を指定して再撮影させる口だけ作り、記事公開時に人（または既存の記事公開バッチ）が叩く。

| 観点 | 評価 |
|---|---|
| 実装量 | **最小**。(a)〜(d) すべての共通部品そのもの |
| 認証 | `lib/cron-auth.ts:43-71` `checkCronAuth`（Bearer `CRON_SECRET` / `x-cron-secret`、`timingSafeEqual` :33-38）をそのまま再利用 |
| 失敗モード | 人が忘れる／叩き忘れる。自動化されない |
| 運用負荷 | 中（人手） |
| 既存資産再利用 | 高 |

---

## 2. 推奨案

**(e) を Phase 1 として必ず作り、その上に (a) を Phase 2 として載せる。(c) は不採用、(d) は (a) が成立しなかった場合の代替として保留。**

理由：

1. **(a) は linkscrawl 側の新規コードがゼロ**。`crawl.changes.detected` / `crawl.completed` の webhook と `GET /v1/crawl/{job_id}/changes`（`content_hash` 実値付き、`mcp_tools/compare_jobs.py:54-60,62,244-245`）が既に本番稼働・テナント分離済み。「変更検知データが本番自動クロールの本流に乗っている」のは `pages.content_hash` 系統だけ（`crawler/parser.py:830-850` → `shared/page_record.py:538,618-623`、migration 038 適用済み）であり、それを外部公開しているのが `/changes`。
2. **(b) は job_id 解決という未確認の穴がある**が、(a) では webhook payload に `job_id` が入るため**その穴が構造的に存在しない**。
3. **(c) は実データが流れない疑いが濃厚**（§1(c) 失敗モード）。しかも mount 解除の理由が BOLA というセキュリティ判断なので、復活には設計上の宿題がついてくる。スクショ再撮影という単一用途にこの負債は割に合わない。
4. **(e) を先に作る理由**：無効化部品は全案の共通前提であり、単体でも価値がある（記事公開直後に運用者が明示的に撮り直せる）。かつ (a) の受信 route と同じ口に相乗りできる（`/api/experiments/pool` が GET=マシン / POST=人 の二経路を1 route に同居させている前例：`app/api/experiments/pool/route.ts:103-139`、意図は `middleware.ts:125-130` に明記）。

**ただし (a) が拾えないもの**を明示しておく：`pages.content_hash` は sha256(**可視テキスト**)（`crawler/parser.py:830-850`）。**画像差し替え・CSS 変更・バナー変更は検知できない**。これは仕様上の穴であり、Phase 3 で `FRESH_TTL` を伸ばす際の上限を決める根拠になる（§4 Phase 3）。

---

## 3. 推奨案の詳細設計

### 3.1 データフロー

```
[linkscrawl / Hetzner]                              [MAP / Vercel]
 crawl 完了
   ├ scheduled crawl → crawl.changes.detected  ┐
   └ すべての crawl  → crawl.completed          ┤
        shared/tasks.py:783                     │  POST (HMAC 署名付き)
        shared/schedule_dispatcher.py:608-634   │  X-LinksCrawl-Signature: t=..,v1=..
        api/webhook_dispatcher.py:143-174 ──────┘        │
        (1/4/16s retry, guarded_fetch SSRF)              ▼
                                          ┌──────────────────────────────┐
                                          │ POST /api/heatmap/invalidate │ ← 新規
                                          │  ① HMAC 検証 (任意でも安全)  │   maxDuration=300
                                          │  ② payload から job_id のみ  │   撮影は一切しない
                                          │     取り出す(他は信用しない) │
                                          └──────────────┬───────────────┘
                                                         │ ③ X-API-Key
   GET /v1/crawl/{job_id}/changes ◄──────────────────────┘
       ?category=content_changed&limit=&offset=
       api/crawl_alias_routes.py:105-138
       → entries[]: { url(=linkscrawl正規化), categories[],
                      current.content_hash, previous.content_hash }
                                                         │
                                                         ▼
                                          ④ matchKey(url) を計算（両側同一関数）
                                                         │
                                                         ▼
                                          ⑤ MAP 自前の URL 在庫と突合
                                             ClickHouse clickinsight.events
                                             canonicalUrlSql('url') / 直近30日
                                             （lib/heatmap/canonical-url.ts:38）
                                             → **R2 キーの入力文字列は常に MAP 側の値**
                                                         │
                                                         ▼
                                          ⑥ 各 (canonicalUrl × device{pc,sp,tab}) について
                                             buildR2Keys() で metaKey を組み
                                             (r2-screenshot-cache.ts:481-493)
                                             meta JSON を GET → capturedAt を
                                             「now - FRESH_TTL - 60s」に書き換えて PUT
                                             (signR2PutUrl / r2-signed-url.ts:82)
                                                         │
                                                         ▼
                                          ⑦ = エントリが SWR 帯に落ちる
                                             次の閲覧で「古い画像を1回返しつつ背景再撮影」
                                             (r2-screenshot-cache.ts:199-203)
```

### 3.2 無効化の実体 —「削除」ではなく「stale マーク」

DELETE 署名は作れない（`lib/scenarios/r2-signed-url.ts` は PUT/GET のみ）。取れる手は meta JSON の PUT 上書きのみで、落とし先は3通りある：

| 手法 | 結果 | 判定 |
|---|---|---|
| `captureVersion` を別値に書換 | `readFromR2` が :340 で即 null → **同期撮影** | ✗ 撮影失敗＝ヒートマップが出ない |
| `capturedAt` を 7d 超に書換 | STALE 超過 → **同期撮影** | ✗ 同上 |
| **`capturedAt` を `now - FRESH_TTL - 60s` に書換** | SWR 帯 → **古い画像を即返しつつ背景で撮り直し** | ✓ **採用** |

採用理由：**連携が暴走して全ページを無効化しても、ユーザーに見えるのは「1回だけ古い画像」だけで、撮影が失敗しても画面は壊れない**。最悪ケースが撮影コスト増だけに閉じる。

実装上の注意：

- meta は `parseMetadata`（:511-549）を通さず **生 JSON を spread して `capturedAt` だけ差し替える**。`parseMetadata` は既知フィールドしか再構成しないため、将来の追加フィールドを落とさないため。
- 追加で `invalidatedAt` / `invalidationSource` / `sourceContentHash` を書いてよい。`parseMetadata` は未知キーを無視するので**後方互換**（read 側の変更不要）。
- backdate 値は `r2-screenshot-cache.ts` の `FRESH_TTL_MS` を**同じ定数から**参照する必要がある（現状 module private :75）。→ `export function staleMarkCapturedAt(now: number): string` を同ファイルに追加して定数の二重定義を防ぐ。
- **L1 は消せない**（`screenshot-provider.ts:312-315` の reset はテスト専用と明記）。したがって **SLA は「通知から最大1h + 次の閲覧1回」**。「即時反映」を仕様に書かない。
- 対象デバイスは `pc` / `sp` / `tab` の3種（`app/api/heatmap/screenshot/route.ts:50`）。

### 3.3 新規実装（ファイル単位）

**linkscrawl 側 — 新規コード0行。運用操作のみ。**

| 操作 | 手段 |
|---|---|
| MAP 用 API キー発行 | `POST /v1/me/api-keys`（`api/me_routes.py:669-704`、生キーは1回だけ返る） |
| webhook 購読登録 ×2 | `POST /v1/webhooks`（`api/webhook_routes.py:31-47`）に `events: ["crawl.changes.detected","crawl.completed"]`、`job_id: null`（テナント単位）、`url: https://<MAP>/api/heatmap/invalidate` |

（Phase 4 の任意拡張として `GET /v1/crawl/{job_id}/pages`（`api/crawler_routes.py:326-436`）に `content_hash` を1列追加する案がある。ただし現行 `page_slice` は `ORDER BY p.crawled_at` で追記ログの古い行が混ざるため、`DISTINCT ON (url) ORDER BY url, id DESC` 規約（`mcp_tools/compare_jobs.py:214-231`）への統一が同時に必要。Phase 1-3 では不要。）

**ugokimap-saas 側**

| ファイル | 種別 | 内容 |
|---|---|---|
| `lib/heatmap/screenshot-invalidation.ts` | 新規 | `markScreenshotStale({tenantId,siteId,pageUrl,device})` — meta GET → backdate → PUT。R2 未設定・meta 不在・`captureVersion` 不一致は no-op で `{skipped: reason}` を返す |
| `lib/heatmap/url-match-key.ts` | 新規 | `heatmapUrlMatchKey(url)`（§3.5） |
| `lib/heatmap/url-inventory.ts` | 新規 | `fetchCanonicalUrlInventory(tenantId, siteId, days, limit)` — `clickinsight.events` を `canonicalUrlSql('url')` で集約（`lib/pages/fetch-pages.ts:86-113` と同型、window を撮影 route の30日に合わせる） |
| `lib/heatmap/invalidation-targets.ts` | 新規 | env `HEATMAP_INVALIDATION_TARGETS`（JSON配列 `{tenantId, siteId, origins:[...]}`）を Zod 検証。**jobId は持たない**（`FUSION_INGEST_TARGETS` の失敗を繰り返さない） |
| `lib/crawler/changes-client.ts` | 新規 | `GET {UGOKICRAWL_API_URL}/v1/crawl/{job_id}/changes` を `X-API-Key` で叩き、`limit/offset` でページング。タイムアウト・件数上限あり |
| `lib/crawler/webhook-signature.ts` | 新規 | `X-LinksCrawl-Signature: t=..,v1=..` の検証（`api/webhook_dispatcher.py:30-60` の TS 移植、リプレイ猶予300s、`timingSafeEqual`） |
| `app/api/heatmap/invalidate/route.ts` | 新規 | POST のみ。`maxDuration = 300`、`runtime='nodejs'`。二経路（§3.4） |
| `middleware.ts` | 編集 | `API_PUBLIC_PATHS`（:132-140）に `'/api/heatmap/invalidate'` を追加＋理由コメント。**この下に子 route を作らない**（:129-130 の prefix 一致の注意書きに従う） |
| `lib/heatmap/r2-screenshot-cache.ts` | 編集 | `staleMarkCapturedAt()` を export（TTL 定数の唯一の出所を維持）。Phase 3 で `FRESH_TTL_MS` を env 上書き可能にする。**読み取りパスのロジックは Phase 1/2 では一切変更しない** |
| `lib/heatmap/screenshot-invalidation.test.ts` 他 | 新規 | 単体テスト（backdate 値、no-op 条件、matchKey、署名検証） |

### 3.4 API 契約

```
POST /api/heatmap/invalidate
Content-Type: application/json
```

認証は**2経路のいずれか**（`/api/experiments/pool` と同型、`route.ts:103-139`）：

| 経路 | ヘッダ | 用途 |
|---|---|---|
| マシン（webhook） | `X-LinksCrawl-Signature: t=<unix>,v1=<hex>` | linkscrawl からの通知 |
| マシン（手動/cron） | `Authorization: Bearer <CRON_SECRET>` または `x-cron-secret`（`lib/cron-auth.ts:43-71`） | 運用者スクリプト／将来の cron |
| 人（オペレータ） | セッション Cookie（`getServerSession()`）＋ `role ∈ {owner, admin}` ＋ `site_ids` 検査 | 管理画面からの明示的な撮り直し |

リクエスト body（3形態を許容、`type` で判別）：

```jsonc
// ① webhook 由来（linkscrawl が送る形。payload は {job_id, summary} のみ）
{ "event": "crawl.changes.detected", "data": { "job_id": "<uuid>", "summary": {...} } }

// ② URL 直指定（オペレータ / スクリプト）
{ "type": "urls", "site_id": "CIP_...", "urls": ["https://.../entry/foo"], "devices": ["pc","sp","tab"] }

// ③ job 直指定（再実行・リカバリ用）
{ "type": "job", "job_id": "<uuid>" }
```

レスポンス（**件数サマリのみ**。`middleware.ts:128` の「応答は件数サマリのみ」規約に従い、URL や tenant を返さない）：

```json
{ "success": true,
  "data": { "changedReported": 42, "matchedUrls": 37, "unmatchedUrls": 5,
            "entriesInvalidated": 96, "entriesSkipped": 15,
            "truncated": false, "durationMs": 8123 } }
```

ステータス：`200` 正常 / `202` 上限打ち切り（`truncated: true`）/ `401` 認証不可 / `409` 同一 job を処理中（Redis single-flight）/ `503` ClickHouse または R2 不達。

**セキュリティ設計の核**：webhook payload からは **`job_id` 文字列しか取り出さない**。tenant / site / URL はすべて MAP 自身の設定と自前 ClickHouse 在庫から再導出する。したがって署名が偽造されても、攻撃者は「自分の API キーが所有しない job_id」しか渡せず、linkscrawl 側が 403/404 を返して何も起きない（`mcp_tools/compare_jobs.py:404-490` のテナント検査）。HMAC 検証は**コスト消費 DoS の防御**として実装する（正当性の根拠ではない）。加えて job_id 単位の Redis dedupe（TTL 1h）で同一通知の多重処理を防ぐ。

### 3.5 tenant / site ID の解決

対応表は**作らない**。理由：この用途に必要なのは「crawler が報告した URL が、MAP のどの (tenant, site) の在庫に載っているか」だけで、linkscrawl 側 ID（`users.id` / `crawl_jobs.id`）を MAP に持ち込む必要が一切ない。

解決手順：

1. `HEATMAP_INVALIDATION_TARGETS` から `{tenantId, siteId, origins[]}` の一覧を読む（現状は tenant が `linkth_internal` 1本、site は `CIP_` 系。`scripts/operator-provision-site.mjs:22,35-42`）。
2. `/changes` の各 entry の URL から host を取り、`origins` に一致する target に振り分ける。一致しない URL は `unmatchedUrls` に計上してスキップ。
3. その target の `(tenantId, siteId)` で MAP 自身の URL 在庫を引く（`clickinsight.events`、直近30日）。**この時点で「MAP が計測しているページか」は自動的に担保される**（撮影 route の `URL_NOT_OWNED` 条件 `app/api/heatmap/screenshot/route.ts:63-93,194-206` と同じ窓）。在庫に無い URL ＝ そもそもキャッシュが存在しない → 何もしなくて正しい。
4. R2 キーの tenant/site は **MAP 側の値のみ**を使う（`buildR2Keys` :488-490 が sanitize する前の生値）。crawler 由来の値は R2 キーに一切入らない。

将来 `site_identity_registry` / `site_identity_binding`（`linkscrawl/docs/ai_data_layer/05_map_behavior_learning.md:442-481`、F-0a 未決）が実装されたら env を差し替えるだけで済むよう、`invalidation-targets.ts` を単一の解決点にしておく。

> 未確認：MAP 対象サイトのクロールが linkscrawl 上の**単一ユーザー**所有かどうか。複数ユーザーに跨るなら API キーも target ごとに持つ必要がある（`invalidation-targets.ts` に `apiKeyEnv` を足すだけで対応可）。確認方法は §6-4。

### 3.6 URL 正規化の一致をどう保証するか

**「crawler の URL から MAP の R2 キーを復元する」ことは原理的に不可能**。`URLNormalizer.normalize()`（`linkscrawl/shared/utils.py:185-220`）が `posixpath.normpath` で末尾スラッシュを非可逆に落としているのに対し、MAP の `canonicalizeHeatmapUrl`（`lib/heatmap/canonical-url.ts:28-30`）は末尾スラッシュを保持し、その文字列の sha256 が R2 キー（`r2-screenshot-cache.ts:487`）だから。

したがって**復元を諦め、突合キーで解決する**：

```ts
// lib/heatmap/url-match-key.ts
// 目的: crawler 正規化と MAP 正規化の既知の差分を「両方から等しく捨てる」
export function heatmapUrlMatchKey(raw: string): string | null {
  const noQuery = raw.split('#')[0].split('?')[0]   // = canonicalizeHeatmapUrl と同一規則
  let u: URL
  try { u = new URL(noQuery) } catch { return null }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')  // www 畳み込み
  const path = u.pathname.replace(/\/+$/, '') || '/'           // 末尾スラッシュ除去
  return `${host}${path}`.toLowerCase()                        // scheme / port を捨て全小文字
}
```

設計の要点：

- **この関数は MAP の中でだけ、crawler 側 URL と MAP 側 URL の両方に適用する**。linkscrawl には送り返さないので、`shared/utils.py:100-112` の `url_match_key()` とバイト等価である必要はない。要件は「既知の差分を全部吸収できるだけ十分に lossy であること」だけ。
- `?p=1` / `?p=2`（MAP は畳む・crawler は分ける）の多対一は、突合後に **MAP 側 canonical URL で dedupe** すれば解消する。
- **衝突は安全側に倒れる**：過剰一致 → 余分に1撮影（コストのみ）。不一致 → 無効化されず TTL 挙動に戻る（現状維持）。**どちらも既存機能を壊さない。**
- R2 キー入力文字列は **常に MAP 側 canonical URL**（ClickHouse `canonicalUrlSql('url')` の出力）を使う。crawler 由来文字列を鍵に使わない。これが正規化非互換に対する構造的な防御。

### 3.7 失敗時の挙動（既存機能を壊さないこと）

| 障害 | 挙動 |
|---|---|
| webhook が届かない / linkscrawl 停止 | 無効化が起きない → **現行の TTL 挙動そのまま**。Phase 1/2 では読み取りパス未変更なので劣化ゼロ |
| `/changes` が 4xx/5xx | route が `503` を返す。R2 は無変更。linkscrawl 側が 1/4/16秒でリトライ（`api/webhook_dispatcher.py:35`） |
| ClickHouse 不達 | 在庫が引けない → 何も無効化しない（fail-closed）。撮影 route と同じ思想（`screenshot/route.ts:207-218`） |
| R2 meta PUT 失敗 | そのエントリだけ `entriesSkipped` に計上して継続。**既存 meta は無傷** |
| 誤って大量無効化 | 全部 SWR 帯に落ちるだけ。ユーザーは「古い画像1回 → 次から新しい」。**画面は壊れない**。コスト増だけが影響 |
| 署名検証を突破された（DoS） | payload から job_id しか使わないため、他人の job は linkscrawl が 403。自 job の再処理は Redis dedupe で no-op。コスト上限は route 内の件数キャップ |
| MAP の新 route が落ちている | linkscrawl の webhook がリトライ後に諦める。MAP 側は完全に現状維持 |
| `content_hash` が NULL | `/changes` は hash 不一致で判定するため NULL は「変化不明」。**NULL 同士を無変更扱いにしない**（`crawler/parser.py:845-850`、`analyzer/evidence_lane/adapters/page.py:26-32`）。MAP 側は `current.content_hash` が null の entry を**無視**し、TTL に委ねる |

**Phase 3（TTL 延長）だけが依存を生む**。ここは `HEATMAP_FRESH_TTL_HOURS` env で上書き可能にし、**再デプロイなしで 24h に戻せる**キルスイッチを必ず同梱する。

---

## 4. 段階的な実装計画

### Phase 0 — 計測と前提確認（コード0行）

§6 の未確認事項をすべて潰す。特に **「本番で対象サイトが定期クロールされているか」** が NO なら Phase 2 は成立しない（通知が永遠に来ない）。

### Phase 1 — 無効化部品 + 手動口（最小で動く形）

- `screenshot-invalidation.ts` / `url-match-key.ts` / `url-inventory.ts` / `invalidation-targets.ts`
- `app/api/heatmap/invalidate/route.ts`（`type: "urls"` 経路のみ、`CRON_SECRET` + セッションの2認証）
- `middleware.ts` に1行追加
- `r2-screenshot-cache.ts` に `staleMarkCapturedAt()` を export
- **読み取りパス変更ゼロ。既存挙動は完全に不変。**

到達点：運用者が「この URL 群を撮り直せ」と言える。記事公開バッチから叩ける。**この時点で「記事更新後すぐ反映」は解決する（人が叩けば）。**

### Phase 2 — webhook 受信で自動化

- `webhook-signature.ts` / `changes-client.ts`
- route に `event` / `type:"job"` 経路を追加
- linkscrawl 側で API キー発行 + webhook 2本登録（コード変更なし）
- Redis dedupe / 件数キャップ / observability ログ

到達点：スケジュールクロール（beat 300s）で変更が検知されると、数分以内に該当ページが SWR 帯に落ちる。**依然として TTL 挙動は無変更なので、連携が壊れても現状より悪くならない。**

### Phase 3 — TTL 延長（本命の費用削減）

Phase 2 が **2週間以上安定稼働**し、「無効化件数 > 0 が毎回記録される」ことを確認してから：

- `FRESH_TTL_MS` を env `HEATMAP_FRESH_TTL_HOURS`（default 24）で上書き可能にし、本番を **168h（7日）** に設定
- 同時に `STALE_TTL_MS` を **FRESH + 猶予（例: 30日）** に引き上げる
  - ⚠ **`STALE ≤ FRESH` にすると SWR 帯が消滅**し、期限切れが全部 90秒枠の同期撮影になる（:195-205 の分岐構造）。必ず `STALE > FRESH` を保つ
- なぜ 7日か：`content_hash` は可視テキストのみ（画像・CSS 変更を検知できない）ため、無限に伸ばせない。7日にすれば **「連携が全滅しても最悪ケースは現行の STALE_TTL と同じ」** で、後退リスクがゼロ

期待効果（要実測、§6-1）：定常状態の撮影回数が「閲覧ページ×3デバイス÷日」から「変更ページ×3デバイス÷クロール」へ。

### Phase 4 —（任意）欠落補填

- クロールが 1回しか走っていない／`/changes` が `available:false` を返すケース向けに、`GET /v1/crawl/{job_id}/export/master`（`api/export_master_routes.py:35-76`、`Hash`列=`content_hash` / `Crawl Timestamp`列=`crawled_at`）で全 URL×hash を取り、MAP 側に前回 hash を保持して自前突合する経路を追加
- または linkscrawl の `GET /v1/crawl/{job_id}/pages` に `content_hash` を追加（§3.3 の注意点付き）

---

## 5. やらない判断の材料

### 代替 A：何も作らず現状維持

- 失うもの：記事更新の反映が最大「24h + 閲覧1回」遅れる。閲覧ページは内容不変でも 24h ごとに撮り直され、Workers browser hours（月10h 枠、`heatmap-backfill/page.tsx:5-6`）を消費し続ける。
- コスト：ゼロ。
- 判断材料：**日次アクティブページ数 × 3 × 1撮影あたり browser 秒が月10h に対してどれくらいか**（§6-1）。ここが余裕なら、この連携は作る必要がない。

### 代替 B：`FRESH_TTL` を単純に伸ばす（連携なし）

- 得るもの：撮影回数の直線的削減。
- 失うもの：古い画像を見せる期間がそのまま伸びる。7日にすれば「記事更新が最大7日反映されない」が**本当に**起きる（現在は起きていない）。
- 判断材料：更新頻度の低いサイトなら**これで十分**。実際、`bihadashop.jp` は「毎日 batch update で sitemap lastmod ≠ publish」という性質がある（過去メモ）ため、更新頻度の実測が必要。

### 代替 C：`FRESH_TTL` を伸ばし、定期バックフィルで全件撮り直す

- 得るもの：全ページが確実に週1で更新される。
- 失うもの：**変更の有無に関係なく 549 撮影/回**。月4回で 2196 撮影。月10h 枠に収まるか極めて怪しい。現行バックフィルはブラウザ Cookie 依存で自動実行できない（`components/operator/heatmap-backfill-runner.tsx:9,64-68`、`heatmap-backfill/page.tsx:8-12` に「スクリプト用トークンは発行しない」既決判断）ため、**自動化するには結局 Phase 1 相当のサーバー側実装が要る**。
- 判断材料：Phase 1 のコストは代替 C の前提コストと大差ない。ならば Phase 1 を作る方が上位互換。

### 代替 D：MAP 単独の条件付き GET（案 (d)）

- 得るもの：リポジトリ跨ぎゼロ、運用ゼロ。
- 失うもの：対象サイトが安定 ETag/Last-Modified を返さなければ機能しない。HTML の弱い ETag は本文以外の変動を拾う（linkscrawl が `crawler/parser.py:833-847` で明示的に否定した罠）。
- 判断材料：`curl -I` 一発で判定できる（§6-5）。**もし対象サイトが安定した ETag を返すなら、これが最もコスト効率が良い可能性がある** — Phase 0 で必ず測ること。

---

## 6. 未確認事項と確認方法

| # | 未確認 | 確認方法 | 影響 |
|---|---|---|---|
| 1 | 1撮影あたりの browser 秒数、および日次アクティブページ数 | Cloudflare Workers dashboard の browser hours 実績 ÷ 期間の撮影回数。撮影回数は `[heatmap-cache]` ログまたは `Server-Timing` の tier=capture 件数 | **やる/やらないの分岐点**。余裕があれば全案不要 |
| 2 | 本番 `pages.content_hash` の非NULL率 | SSH トンネル復旧後（127.0.0.1:5433）に `SELECT count(*) FILTER (WHERE content_hash IS NOT NULL), count(*) FROM pages WHERE job_id='<最新job>'` | NULL 率が高いと (a) の検知漏れが増える |
| 3 | **対象サイトが本番で定期クロールされているか**（P-F5 スケジュール登録の有無） | `crawl_jobs` の直近 30 日の行を target_url 別に集計／schedule テーブルの確認 | **NO なら Phase 2 は成立しない**（`crawl.completed` すら飛ばない）。最重要 |
| 4 | 対象サイトのクロールが linkscrawl 上の単一ユーザー所有か | `SELECT DISTINCT user_id FROM crawl_jobs WHERE target_url LIKE ...` | API キーを target ごとに持つ必要があるか |
| 5 | 対象サイトが安定した ETag / Last-Modified を返すか | `curl -I https://bihadashop.jp/entry/<slug>` を時間差で2回、値が一致するか | 案 (d) の成否。安定なら (d) が最安 |
| 6 | `crawl_export_v1` のセクション配列が本番で実際に埋まるか（案 (c) 評価用） | `mcp_tools/crawl_export.py` が `page_content_map` を SELECT しているかを読む＋本番で `SELECT count(*) FROM page_content_map` | 案 (c) を検討し直す場合のみ必要。現時点の推測では空 |
| 7 | `/v1/crawl/{job_id}/changes` のレスポンスに job の root/target URL が含まれるか | `api/crawl_alias_routes.py:105-138` と `compare_jobs.get_job_changes()` の返却スキーマを読む | 含まれるなら §3.5 の host 振り分けが簡略化できる（無くても設計は成立） |
| 8 | Vercel 本番 env に R2 書き込み資格情報があるか | `getR2ConfigFromEnv()`（`lib/scenarios/r2-signed-url.ts`）が撮影パスで成功している以上ある可能性が高いが、`vercel env ls` で確認 | 無ければ Phase 1 が動かない |
| 9 | MAP 本番 URL（webhook 登録先ホスト） | `ugokimap-saas.vercel.app` と `ugokimap.com` のどちらを正とするか。オーナー確認 | webhook 登録値 |
| 10 | 現行 `STALE_TTL` 超過（同期撮影）が実際どれくらい発生しているか | `Server-Timing` の tier 分布（`r2-screenshot-cache.ts:123` の `R2CacheTier`）を集計 | Phase 3 の効果見積もり |

---

## 7. 一行サマリ

**`GET /v1/crawl/{job_id}/changes` + 既存 webhook（linkscrawl 側の新規コード0行）で「変わった URL」を受け取り、MAP 側で自前の ClickHouse 在庫と lossy な matchKey で突合し、R2 の meta JSON の `capturedAt` を SWR 帯に backdate する** — これが既存資産に最も乗り、かつ連携が全滅しても既存挙動に自然フォールバックする唯一の形。ただし着手前に §6-1（そもそも撮影コストが問題か）と §6-3（対象サイトが定期クロールされているか）を必ず実測すること。この2つが空振りなら、本連携は作らないのが正解。