# UGOKI LINK v2 全波完了後・独立4レーン厳格レビュー＆全71件一括是正報告書（REVIEW_REPORT）

- **監査実施日**: 2026-11-20（監査対象 HEAD: `ca0bb1c` — 全 32 束・387 変更ファイル）
- **一括是正完了日**: 2026-11-22（**Wave 8 にて全 71 / 71 件を修正・敵対的回帰テスト追加・再検証完了**）
- **監査基準**:
  1. 正本設計書 `docs/proposals/2026-11-19-ugokilink-master-architecture-v2.md`（§0〜§18）
  2. 実装計画 `docs/proposals/2026-11-20-ugokilink-implementation-plan.md`
  3. 追加計画 `docs/proposals/2026-11-20-ugokilink-implementation-plan-addendum-ml.md`
- **監査・是正体制**: `COMPLETION_REPORT.md` の自己申告を排し、独立した読み取り専用の敵対的レビュアー 4 レーン（Slice 1: 契約/SDK/受付/再生、Slice 2: 分離/SQL/サンドボックス/保存/DDL/波0-A残存、Slice 3: 行為者/突合/EC/検索/ヒートマップ/AI層、Slice 4: ML/Jev/配信/WP/自律/API統合）で実コードと数式・境界条件を全件突合。検出された **計 71 件（Critical 18・High 30・Medium 18・Low 5）** を Wave 8 の排他 4 レーンで **100% 是正済み**。

---

## 0. 総括（監査所見と Wave 8 是正結果）

波 0〜波 7 完了時点（`ca0bb1c`）では単体テスト（53 スイート / 958 テスト）・型検査・Next.js ビルドは通っていたものの、敵対的監査により「束と束の接続境界の不整合」「認証・テナント分離・サンドボックスのバイパス穴」「数理・統計エッジケースの欠陥」が重複除外後で **計 71 件（Critical 18 件・High 30 件・Medium 18 件・Low 5 件）** 検出された。

これを受け、**Wave 8（全 71 件一括是正）** を実施し、すべての指摘事項に対する本実装修正と攻撃再現回帰テスト（+131 テスト）を追加した。是正後の検証結果は以下の通り：
- **統合 Jest テスト**: **56 / 56 スイート・1,089 / 1,089 テスト全 PASS（失敗 0・保留 0）**
- **0-C 本番記録 Node テスト**: **9 / 9 PASS**
- **既存 `workers/event-ingest` 回帰テスト**: **101 / 101 PASS**
- **TypeScript 型検査 (`npm run type-check`)**: **0 エラー（exit 0）**
- **Next.js 本番ビルド (`npm run build`)**: **成功（exit 0、静的 60 ページ ＋ `/api/v1/**` 全 20 ルート `OPERATION_CATALOG` 1:1 完全一致）**

### 敵対的監査で健全性が確認された点（Good）
- **判断 31-b（Jev 学習・蒸留永久禁止）**: 台帳 `D-31b` の `prohibited_by_decision` ロック、`JevTrainingProhibitedError`、`JevTeacherProhibitedError` が二重・三重に機能（検査順序とネスト深さの 2 点のみ改善余地あり）。
- **べき等マージ代数 & 10 万通り収束 (`workers/link-loader/merger.ts`)**: ドロップ・重複・順序逆転に対する可換・べき等収束と単一配置フェンスは数学的に健全。
- **純 TS 決定論的 PNG エンコーダ (`lib/link/heatmap-render/renderer.ts`)**: PNG シグネチャ・`IHDR`・行フィルタ `0` + RFC 1950 `IDAT`・`IEND`・IEEE 802.3 `CRC32` すべて仕様準拠。
- **閉じた文法ランタイム (`packages/sdk-runtime/interpreter.ts`)**: `innerHTML` / `eval` / `<style>` 不使用・gzip 2,551 B（≤ 14 KB 予算内）を達成。

---

## 1. Critical 指摘一覧（18 件 — 本番適用前に必須修正）

| ID | 領域 | ファイル : 行 | 問題の本質と再現条件 | 修正方針 |
|---|---|---|---|---|
| **C-01** | API 認証 | `middleware.ts:196, 500` / `lib/link/surface/http-adapter.ts:47, 178-199` | `middleware.ts` が `/api/v1/**` を旧人間用 `'api-tenant'` として旧 HS256 `jwtVerify` に掛けるため、v2 の `ugk_sec_*`・OAuth・OEM トークンがルート到達前に **100% 401 遮断**される。また `UGOKILINK_KEY_PEPPER` に固定文字列フォールバックがあり、`/api/v1/mcp` の `tools/list`・`enable` が無認証公開されている。 | `middleware.ts` で `/api/v1/` は偽装ヘッダ除去の上 v2 パイプライン認証へ委譲、`/api/v1/mcp` 全メソッドに Bearer 認証必須化、本番 Pepper 未設定時 fail-closed。 |
| **C-02** | API 認証 | `app/api/v1/sites/[siteId]/heatmap-image/route.ts:20-61, 121-147` | `AuthorizationGateway` を通らず未検証の自己申告ヘッダ `x-ugk-principal-id` / `x-ugk-tenant-id` / `x-ugk-scopes` と `body.tenant_id` をそのまま信頼。`x-ugk-audience` 省略で `'site_owner'` になり `<10` 伏せ・差分防御も全無効化。 | `extractPrincipalFromRequest` を全廃し `SurfacePipeline` + `IdentityKeyRegistry` + `AuthorizationGateway` に一本化。`audience` と `unit_datasets` はサーバー側導出のみ。 |
| **C-03** | ヒートマップ秘匿 | `lib/link/heatmap-render/service.ts:242-251, 606-668, 795-808, 918` | ① `status: 'suppressed'` 区画で `reach_rate` のみ `null` 化し生の `reach_pvs` / `dwell_pvs`（`<10` 実数）を JSON 返却。② 開示判定より前にキャッシュヒットを返すため `<10`・差分攻撃が素通り。③ `GET` で `site_owner` 用の未伏せ PNG を `external_party` へ返却。④ `reproHash` に `tenant_id`/`site_id` が無く衝突上書き。⑤ 削除時に `artifactsById` 未消去。 | 抑制時は全件数フィールドも `null`/マスク化。開示判定をキャッシュ参照前に移動し、キーに `(tenant_id, site_id, audience, period, segment)` を含め、`GET` でも `audience` 一致検証、削除時 `artifactsById` 即消去。 |
| **C-04** | 受付認証・課金 | `workers/link-collector/collector.ts:84-113, 286-323` / `worker.ts:87` | ① `hmac.slice(0, macHex.length)` が最小長未検査のため `X-Ugk-Handoff: any.0`〜`any.f`（1文字=4bit）で **16 回以内に最高信頼度 `edge_attested` を偽造可能**（急増遮断器・日次課金上限を突破）。② `X-Ugk-Prefix` ヘッダをクライアントから信頼し、通常訪問者は全員 `'0.0.0.0/24'` に衝突して 500 PV で非課金化する一方、攻撃者はヘッダ変更＋無期限 `pv_token` で 100 万件課金水増し可能。 | MAC 最小長 32 hex 固定＋定数時間比較、`pv_token` に 30 分 TTL 付与、`x-ugk-prefix` 廃止（`CF-Connecting-IP` からサーバー側で `/24`・`/48` 算出）。 |
| **C-05** | 受付↔WAL 配線 | `workers/link-collector/collector.ts:389` / `workers/link-wal/wal-writer.ts:431-465` / 各 `types.ts` | ① `collector` が送る `PersistedCollectorRecord` と `WalWriter` が要求する `WalQueuePayload`（`storage_region`, `shard_id`, `raw_frame`）の型が不一致で、実 Queue 接続時に **100% 隔離行き**。② `collector` → `link-live` DO 未接続。③ 3 車線の列挙値が 4 通りに分裂（`customer_defined` vs `custom_event` vs `customer_events` 等）。 | `packages/contract/schema` の単一車線列挙＆単一 Queue エンベロープ型に全パッケージを統一し、`collector` に `link-live` 非同期ファンアウトを実装。 |
| **C-06** | スニペット起動・TT | `packages/sdk-snippet/snippet.ts:110-120` | ① インラインスニペットが呼ぶ `w.__ugkVerifyAndBoot` が全リポジトリで未定義のため **実ブラウザで一切起動しない**。② `trustedTypes.createPolicy` が無検査パススルー関数を返し `w.__ugkLoadSri` をグローバル公開（Trusted Types バイパスガジェット）。 | WebCrypto Ed25519 検証＆ロード処理をスニペット内に自己完結実装し、Trusted Types ポリシーは許可オリジン＆検証済みマニフェスト URL のみに制限、グローバル露出を削除。 |
| **C-07** | 返答封筒 I2/I3/I5/I7 | `packages/contract/response/{untrusted,brand,envelope}.ts` | ① `isUntrustedValue` が余剰キー・`hasOwnProperty` 未検査のため `{...wrapUntrusted(...), leak:'...'}` や `Object.create(wrapUntrusted(...))` で生文字列が素通り。`toJSON()` や `policy_url` 免除も穴。② `brand.ts` が公開取得可能な Symbol＋プロトタイプ継承のため `Object.create` で任意数値を偽造可能、かつ `input.data` 内数値が未検査。③ `isPassingProvenPredicate` が `NaN`（`NaN < 14 === false`）と墓標参照を通し `proven` 偽装可能。 | `brand.ts` を閉包 `WeakMap` 化、`isUntrustedValue` で厳密プロトタイプ＆キー数検査＋`policy_url` 免除廃止、全数値に `Number.isFinite` 必須化、`proven` で非墓標＆`integrity_status === 'pass'` 強制。 |
| **C-08** | URL キー受付 | `packages/contract/urlkey/urlkey.ts:674, 903` / `workers/link-collector/collector.ts:245, 352` | ① `verifyUrlKeyIdempotency` が `raw === f(raw)` ではなく `f(raw) === f(f(raw))` を見るため、`https://alice:pass@example.com/search?q=秘密` が `idempotent=true` で **生文字列のまま WAL/DB に保存**される。② 空文字や `staging:8080/page`（2回目で未知スキーム誤認）で未捕捉 `UrlKeyError` 500 クラッシュ。 | `input === first.url_key_v2` の厳密不動点検査に修正、常に正規化済み `first.url_key_v2` のみを保存、`try/catch` 隔離化、単一ラベル `host:port` のスキーム補完修正。 |
| **C-09** | モバイル SDK 生成 | `packages/sdk-mobile/generator.ts:25-226` | 生成される 4 言語コードの `flushIfOnline()` がすべて空 `{}` で、イベント記録・同意変更・永続キュー消去メソッドも無く、Swift はタプル `(Double,...)` を `JSONSerialization` に渡す実行時クラッシュバグを含む。 | 4 言語すべてでイベント記録・同意変更・上限/TTL キュー・HTTP 送信・撤回時メモリ/永続全消去を実コード生成し、Swift を `Codable`/`[Double]` 化、構文/トランスパイル検査を追加。 |
| **C-10** | SQL 字句解析 | `lib/link/isolation/ast-inspector.ts:267` / `lib/link/export/sql-interface.ts:171` | `stripStringLiterals` が `\` の連続偶奇を見ないため、正常な `'\\'` と末尾 `'\''` で挟んだ全 SQL（`;`, `SETTINGS`, `SELECT *`, `url()`, `remote()`, `system.tables`）が空白化され無検査通過する。 | 連続バックスラッシュ偶奇・クォート・コメントを厳密処理する SQL トークナイザ＋再帰下降 AST 検査器に置換。 |
| **C-11** | SQL テナント境界 | `lib/link/isolation/ast-inspector.ts:378-477` / `sql-interface.ts:239-272` | ① `WHERE tenant_id = {tenant_id:String} OR 2=2` でテナント条件無効化。② `SELECT 'tenant_id = {tenant_id:String}'` の文字列定数偽装で WHERE 無し通過。③ `UNION ALL` 第 2 SELECT・サブクエリ・`PREWHERE` 未検査。④ `FROM v_page_hourly, system.tables` カンマ結合の第 2 テーブル未抽出。 | 全 `SELECT` ブロック・カンマ結合含む全テーブルを抽出し、各スコープ最上位 `AND` 項での `tenant_id` バインド必須化・並列 `OR` 禁止・`UNION`/`PREWHERE`/`system`/`information_schema` 拒否を強制。 |
| **C-12** | `node:vm` 脱出 | `lib/link/export/destination-functions.ts:173-207` | ホストの `Object`/`JSON`/`Array` を `vm.createContext` に渡しているため、`Object.constructor('return process')()` で **ホスト側 `Function` を取得してサンドボックス完全脱出**可能。`Object.prototype` / `JSON.parse` 書き換えによる他テナント秘密ヘッダ汚染とヒープ OOM も可能。 | ホスト組込オブジェクト注入を全廃、使い捨て `worker_threads`（`resourceLimits` メモリ上限＋タイムアウト＋権限隔離）または隔離ランタイムで JSON 文字列のみ往復させる。 |
| **C-13** | R4 削除 Passkey | `lib/link/auth/gateway.ts:906-930` | `enforceR4`（サイト/テナント完全削除等）が `if (!req.passkeyApprovalId)` の非空確認しかしておらず、`this.approvals` 台帳照合・消費を行っていないため `"dummy"` 文字列で突破可能。 | `enforceR2` と共通の `consumeVerifiedPasskeyApproval()` を `enforceR4` でも必須実行し、日次削除件数も累積管理する。 |
| **C-14** | CH / PG DDL 破綻 | `migrations/link/001_clickhouse_v2.sql` / `002_postgres_v2.sql` / `ddl-generator.ts` / `row-policy.ts` | ① CH `frame_quarantine` が `pv_id Nullable(UUID)` を `allow_nullable_key=1` 無しで `ORDER BY` に含め構文エラー。② CH の 2 つの `RESTRICTIVE` 行ポリシー（`currentUser()` 置換 vs `ugk_ro_<sha256>` の生 `tenant_id`）が矛盾して **全テナント 0 件ロックアウト**。③ PG RLS に `AS RESTRICTIVE` しか無く `PERMISSIVE` 0 件のため **全アクセス拒否**。④ `TENANT_TABLE_CATALOG` / `PUBLIC_SQL_VIEWS` と DDL 実テーブル名が不一致。 | `ddl-generator.ts` と `row-policy.ts` を単一方式に統一、PG に `PERMISSIVE` + `RESTRICTIVE` 両出力、`frame_quarantine` 修正、テーブル/ビューカタログを `CANONICAL_SCHEMA` から自動生成して再出力。 |
| **C-15** | 他テナント WAL 流出 | `workers/link-wal/wal-writer.ts:585-631, 752` / `storage-adapter.ts:259-268, 331-342` | `WalWriter` が同一シャード・同一分に複数テナントのフレームを 1 つの `WalObject` に混在させ、Tier 2 / Tier 3 アダプタがテナント分離せず顧客バケットへ直接書き出す（他テナント生データ漏洩）。隔離データも未暗号化。 | WAL スライスを `(tenant_id, site_id, shard_id, minuteUtc)` で物理分離し、Tier 2/3 書出時に `tenant_id` 一致検証を強制、隔離オブジェクトをテナント鍵 AES-256-GCM 暗号化。 |
| **C-16** | エージェント公開 | `lib/link/autonomy/agent-publisher.ts:53-59, 264-286, 387-502` | ① `provenance: 'open'` や未知文字列・ネストオブジェクトが `if/else if` 末尾漏れで素通りし自律署名される。② エージェント自己申告の `allowedValues` を信頼。③ `touchesDestination` 等が自己申告 boolean。④ `humanApproval` をサーバー台帳照合・消費せずリプレイ無制限。 | `switch` default fail-closed＋スカラー値限定、サーバー登録スロット定義参照、URL/ホスト/価格の機械検査、`AuthorizationGateway` での Passkey 1 回限り消費に統一。 |
| **C-17** | WP 2 鍵バイパス | `packages/wp-plugin/ugokilink-companion.php:213-219` / `contract.ts:276` | ローカル方針を超えられるかをクラウド署名ペイロード内の自己申告 `owner_wp_admin_confirmed: true` で判定しており、LINK 側 1 鍵侵害だけでオーナーのローカル方針を突破可能。 | ペイロード自己申告を廃止し、WP 管理画面側で管理者がローカル `wp_options` に記録した `(post_id, before_sha256, after_sha256, seq)` 承認ハッシュとの一致のみで解禁する真の 2 鍵方式へ修正。 |
| **C-18** | Signer 緩和バイパス | `workers/link-signer/worker.ts:70-91` / `signer.ts:260-341` | `/v1/signer/bundle/sign` が無認証公開されており、かつリクエストで `previousBundle` を省略すると `seq` 単調増加検証もプライバシー緩和 Passkey 検証もスキップして `full` 同意束に署名してしまう。 | 内部制御プレーン認証を必須化し、`previousBundle` はリクエストから受け取らず強整合ストアから読み出して CAS 更新、`expectedDiffSha` に `(tenant_id, site_id, prev_seq)` を束縛。 |

---

## 2. High 指摘一覧（30 件 — 本番稼働・精度・法務遵守に直結）

1. **[H-01] 束横断 OpenAPI / MCP / 8言語 SDK 統合漏れ (`lib/link/surface/openapi.ts`, `mcp.ts`, `packages/sdk-server/generator.ts`, `app/api/v1/**`)**: `POST /v1/decisions`・`POST /v1/recommend`・`heatmap-image` が `OPERATION_CATALOG` / MCP `tools/list` に未登録。逆にカタログ登録済み 5 操作（`insights`, `notifications`, `decisions/publish`, `origin/apply`, `grants`）のルートファイルが未作成、`segments/compare` のパス不一致、8 言語 SDK に REST 呼び出しメソッド未生成。
2. **[H-02] `POST /v1/recommend` 認可・未登録 `siteId`・候補偽装 (`lib/link/models/recommend-service.ts:335-423, 625, 702`)**: `AuthorizationGateway`/レート制限未経由、未登録 `siteId`（`siteCfg === null`）が 200 OK 通過、ブラウザ経路（`ugk_pub_*`）から候補リスト・粗利・同意フラグを注入可能。
3. **[H-03] `POST /v1/ask` 実行後フィルタ・補集合 1 人リーク・差分攻撃バイパス (`lib/link/ask/{ask-service,pre-llm-filter}.ts`)**: DB クエリ実行後にフィルタを呼ぶ順序逆転、実 SQL テーブル未照合、`GROUP BY` で 1 人セル抑制時の二次抑制欠如による引き算特定、`filterSignature` に期間を含めないことによる期間ずらし差分スキップ、4 クエリ Tracker 線形結合。
4. **[H-04] 3 分割データセットの事前重複削除による Union-Find 切断 (`lib/link/ml/finetune/dataset-builder.ts:102-114, 267-305, 366-444`)**: Union-Find より前に近傍重複 2 件目以降を捨てるため系譜間の橋渡しが切れて `train`/`final_eval` リークが発生。さらに辞書順 4-gram の ASCII 偏り、Jev 出どころ検査より先に Poisoning 隔離が走る順序逆転、`capMultiOwnerWeights` 10 回打ち切り非収束。
5. **[H-05] LORD++ オンライン FDR の初回棄却報酬過大 (`lib/link/evidence/experiment-engine.ts:345-399`)**: 初回棄却時に $\alpha - W_0$ ではなく $\alpha$ を足すため $\sum \alpha_t = 1.5\alpha > \alpha$ となり FDR 保証が破綻、かつ直近 1 件以外の過去棄却履歴が消失。
6. **[H-06] `always_valid` 逐次検定の固定ホライズン $z$ 検定流用 (`lib/link/evidence/experiment-engine.ts:86-95, 123-141`)**: mSPRT ではなく通常の正規 $p$ 値を使うため継続覗き見で偽陽性率が膨張。
7. **[H-07] 10,000 回適応配分リプレイの非冪等フロア二重適用 (`lib/link/rollout/adaptive-allocation.ts:95-137, 274`)**: `normalizeProbsWithFloor` が二重に掛かり帰無分布の分散が縮小して偽陽性を誘発。
8. **[H-08] WP プラグインのサイト横断リプレイ DoS・TS/PHP 署名形式不一致・`SodiumException`・投稿ロック誤消去 (`packages/wp-plugin/{ugokilink-companion.php,contract.ts}`)**: `site_id`/`home_url` 未拘束で他サイトの `command_seq` を釣り上げ恒久 409 DoS 可能、TS `payload` vs PHP `payload_canonical_json` 不一致、`daily_apply_cap` 未実装、不正長署名で 500、人間編集ロックの `finally` 誤削除。
9. **[H-09] `InsertNode` アフィリエイト注入・`expressions.ts` `A1c`/`A2` 未検査・CMP `'off'` 上書き (`workers/link-signer/grammar-validator.ts`, `lib/link/delivery/expressions.ts`)**: `InsertNode` でアフィリエイト `href` 注入可能、`validateExpressionSpec` が `A1c`/`A2` をスキップ、`cmpResolved` が `siteDefault: 'off'` を上書き。
10. **[H-10] ブラウザ SDK の計測 20 項目ドロップ & `ConversionRuleSpec` 型不一致 (`packages/sdk-browser/{behaviour,sdk}.ts`, `workers/link-signer/types.ts`)**: 内部計算済みの `gap_ms[4]`, `vel_ms[4]`, フォーム躊躇/修正、クリック相対位置/連打/無反応、区画遷移 `sectionTokens` 等が `buildFrame` で欠落。
11. **[H-11] ブラウザ SDK の同意降格時 Cookie/WAL/`fetchLater` 残留・`UNKNOWN` 法域 `'cookieless'`・非公開ページ照合キー送信 (`packages/sdk-browser/{consent,sdk}.ts`, `workers/link-collector/worker.ts`)**: 降格・オプトアウト時に既存 Cookie や装填済み `fetchLater` が残存、`UNKNOWN` 法域が `'off'` でない、`/v1/optout` が削除計画未接続、`private_scope` で照合キー送出。
12. **[H-12] `urlkey/2` の壊れた `%` 併用 PII マスク回避・大文字/ワイルドカード検索パス漏れ・`https:///` ホスト重複 (`packages/contract/urlkey/urlkey.ts`)**: `alice%40example.com%ZZ` で `URIError` により PII 判定不発、`/Search/語` や `/search/cat/語` 漏れ、未登録検索パスの `unknowables.ts` 記載漏れ。
13. **[H-13] リプレイ階層 3 の `allowlist` 内 `<script>`/`<style>`/`<foreignObject>`/動的ノード漏洩・機微欄停止未接続・使い捨てハンドル再利用 (`lib/link/replay/{masker,store,player-sandbox}.ts`)**: 開放領域内の `<script>` が `<div>` 化して秘密 JSON 表示、`detectedSensitiveFieldOnPage` を `putReplay` が無視、AES-GCM AAD 欠落、ハンドルが複数回利用可能。
14. **[H-14] Segment 互換・カスタムイベントのサイズ/PII/学習除外バイパス (`workers/link-collector/segment-compat.ts:322-385`)**: `customEventRegistry` 未設定時や `page`/`identify` 等で 32 KiB・100 項目・PII 検査をスキップし `mlTrainingEligible = true` になる。
15. **[H-15] 部分受理クランプ後のチェックサム未再計算 & 14 日削除計画の新車線漏れ (`packages/contract/schema/{ingest-validator,canonical}.ts`)**: 1 項目クランプ後に旧 `chk` のままのため `WalWriter` で全 PV `state_incomplete` 化。削除計画にリプレイ・スピル・Segment 属性・EC 注文等が未登録。
16. **[H-16] モバイルライフサイクルの同意変更時キュー残留・未承認 `traits` 保持 (`packages/sdk-mobile/lifecycle.ts`)**: 同意降格時に待機キューを再フィルタせず送信、未承認 `traits` をエンキュー前に落としていない。
17. **[H-17] SSRF フィルタの IPv6 16進射影 (`::ffff:7f00:1` / `::ffff:a9fe:a9fe`) 素通り・リダイレクト秘密ヘッダ転送 (`lib/link/export/destination-functions.ts:110-147, 483`, `lib/link/linkage/grant-service.ts:90-134`)**: 16進表記 IPv4-mapped IPv6 や展開表記で `127.0.0.1`・`169.254.169.254` が通過、リダイレクト先へ Vault 認証ヘッダ転送、`grant-service` で `resolvedIp` 空時に fail-open。
18. **[H-18] ClickHouse 短期 TTL テーブルの `PARTITION BY exp_week` × `ttl_only_drop_parts = 1` による 30/35 日消去不全 (`migrations/link/001_clickhouse_v2.sql:44, 69, 516`)**: 13〜36 ヶ月先の `exp_week` パーティション全体が満了するまで 30/35 日 TTL 行が消えない。
19. **[H-19] `DeletionExecutionEngine` の非標準 SHA-256 ダイジェスト不一致・DO/Stream/EC/Ask/ML 未接続 (`lib/link/store/deletion-engine.ts:134`)**: RFC 2104 HMAC ではなく単純連結 SHA-256 のため取込側ハッシュと一致せず削除空振り、WAL 再構築時の削除墓標照合も未実装。
20. **[H-20] セルフサーブ導入の外部動的 `<script src>` 発行・平文秘密鍵保持 (`lib/link/export/self-serve-billing.ts:134-158`)**: 固定 SRI スニペットではなく外部動的 URL を返し、`IdentityKeyRegistry` 未登録のまま平文秘密鍵を保持。
21. **[H-21] `ShardLoader` / `SealedRollupBuilder` の `lab_run_id` 人集計混入 & 無風時間帯の恒久 `insufficient_data` (`workers/link-loader/{loader,rollup-builder}.ts`)**: 検査走行 PV が確定集計に混入し、PV 0 件の 1 時間があると `sealedThrough` が止まり 2 時間後に恒久 `insufficient_data` 化。
22. **[H-22] OSS 公開境界マニフェストの旧パス指定 & `'unclassified'` Fail-Open (`lib/link/residency/oss-prep.ts:57-70, 165-201`)**: 実在するボット判別・ML モデル群が `'unclassified'` となりエラーにならず通過する。
23. **[H-23] 波 0-A 残存: 旧 `lib/analysis-axes.ts` (29 クエリ)・`lib/api-utils.ts`・`screenshot`・`gsc_data` の `tenant_id` 欠落、および `seo/internal-links` (`?job_id=` IDOR)・`seo/access` (`'link-th.com'` GSC フォールバック)**。
24. **[H-24] OEM 親キー失効後の子交換トークン残存・`analytics:export` 未検査・LinkGrant Passkey 鮮度未検証 (`lib/link/auth/keys.ts:985`, `oem-manager.ts:415`, `grant-service.ts:530`)**。
25. **[H-25] ヒートマップ差分推論ガードの 3 クエリ線形結合・1 日ずらし `segment_id="all"` スキップ・同数入替突破 (`lib/link/heatmap-render/service.ts:117-220`)**。
26. **[H-26] RFC 9421 の `@path`/`@method` 未拘束リプレイ・未登録 `Signature-Agent` 横断 JWKS 混同・辞書型 `;key="g"` パース破壊・不正 JWK 未捕捉例外 (`lib/link/actors/verdict-engine.ts`)**。
27. **[H-27] 物販 EC Webhook の `raw_body` 非パース乖離・2 パケット順序逆転での全商品永久停止・`503` 未ロールバック・古価格露出・粗利 `null` 残留 (`lib/link/revenue/ec-catalog.ts`)**。
28. **[H-28] `EcMemberSummaryStore` の古い `data_epoch` 巻き戻し＆初回削除競合による削除済み会員要約の復活 (`lib/link/revenue/ec-member-store.ts`)**。
29. **[H-29] Origin Kit Nginx の `HttpOnly` Cookie 値 `Server-Timing` 露出＆`$msec` 小数パース失敗・同意前 Cookie 発行・月跨ぎ単一 IP の 3 ネットワーク定足数突破 (`lib/link/actors/{origin-kit,handoff,log-ingest}.ts`)**。
30. **[H-30] `LocalAiModelCertificate` の合否ゲート欠如・野生上限の点推定割り算・$k \ge 1$ Wilson 被覆割れ・60 次元ガウス正規化定数欠落・`model_inferred` 特徴除外漏れ (`lib/link/ai-layer/local-ai-scorer.ts`, `actor-experiment.ts`)**。

---

## 3. Medium / Low 指摘一覧（Medium 18 件・Low 5 件）

### Medium（18 件）
- **M-01** (`packages/contract/response/envelope.ts`): 非 `ok` 時の空 `unmet_gates: []` 通過、`status: 'invalid'` 時の `point_estimate` 通過、`D-09` 未決時の予測帯通過、`validateSerializedEnvelope` の `sample`/`interval` 検査省略。
- **M-02** (`workers/link-collector/collector.ts`): 別インスタンス到達時の `post_ack_loss` 見逃し、インメモリ `Map` 無制限成長。
- **M-03** (`packages/contract/segmenter/html-parser.ts`): `<svg><foreignObject>` 内の `<p>` 自動閉じ・`<style>` 処理のブラウザ DOM との不一致。
- **M-04** (`lib/link/oem/billing-guard.ts`): `perPrefixLaneCounts` に `dayUtc` が無く、遮断前に最大 5,750 単位の `continuity` 課金が発生。
- **M-05** (`lib/link/migration/{calibration,legacy-bridge}.ts`): `G-17` CV 同等性検定が片側 `>= 0` のみ、旧データ橋渡しでスクロール 0 件 PV が全欠落。
- **M-06** (`lib/link/export/warehouses.ts`, `lib/link/ask/ask-service.ts`): 相補的秘匿が日別ではなくバッチ全体で `count === 1` 判定、`ask-service.ts` の SQL メトリクス文字列連結。
- **M-07** (`app/api/scenarios/runtime/route.ts`, `components/experiments/hypothesis-ab-dashboard.tsx` 等): 旧 POC シナリオ一時停止バイパス・`/experiments` 画面の `INITIAL_EXPERIMENTS` 架空表示残存。
- **M-08** (`app/api/experiments/pool/route.ts`): `lib/cron-auth.ts` 未使用（`x-vercel-cron` 信頼・非定数時間比較）。
- **M-09** (`lib/link/revenue/reconcile-g13.ts`): `d_i === 0` 時の二項誤差フロア未実装、$n=14$ で $t$ 分布でなく $z=1.96$ 使用、比率 `net/own` 逆転、0 件日算入。
- **M-10** (`lib/link/search/{query-section-mapper,ai-search-probe}.ts`): Fréchet/Manski と引用挟み込みへの点推定直接代入（1 件で幅 0）、`join.G14`・`act.G25` 未適用。
- **M-11** (`lib/link/clocks/actor-evidence-snapshot.ts`, `crawl-contract-stub.ts`, `drift.ts`): アーカイブ開始前 `retro` 参照での誤 `refuted` 判定、`assertValidLinkGrant` 署名未検証、初回描画種別 `identity_render` vs `full_render`。
- **M-12** (`lib/link/models/popup/selection-policy.ts`): `verifyBanditPolicyByFullUnitReplay` が実際には 10,000 回ループを回さず定数返却＆非対標本比較。
- **M-13** (`lib/link/models/recommend/{recommender,ec-recommender}.ts`): Plackett-Luce の条件付きステップ確率を周辺 `display_prob` として記録。
- **M-14** (`lib/link/ml/foundation/{int8-tree-runtime,decision-token}.ts`): `numArms > 2` で `serverUniformU` 乱数無視、`measuredGzipBytes` 自己申告信頼、HMAC 非定数時間比較。
- **M-15** (`app/api/v1/decisions/route.ts`): `verifySecretKey` に `clientIp` / `senderThumbprint` 未渡し、レート制限未適用、エフェメラル署名鍵。
- **M-16** (`workers/link-zone/zone-worker.ts`, `workers/link-decision/decision-worker.ts`): パススルー時の `Cache-Control: public` + `Server-Timing` 混入、Amazon Lab Sink 漏れ、1-PV 拘束未結線。
- **M-17** (`packages/sdk-runtime/interpreter.ts`): `rollbackClosedGrammarPatch` の `prevAttributes` で `__proto__` / 非許可属性チェック漏れ。
- **M-18** (`lib/link/ml/llm/{jev-client,provider}.ts`, `finetune/labeling.ts`): 禁止データ再帰検査の `depth > 6` 打ち切り（fail-open）と `labeling.ts` の浅い検査。

### Low（5 件）
- **L-01** (`packages/contract/schema/types.ts` vs `sdk-browser`): 法域 `'GB'` vs `'UK'` 表記揺れ、SPA ソフト遷移時の `skelFp` 再計算漏れ。
- **L-02** (`lib/aiseo/internal-link-loader.ts`): `siteId` パス結合の関数単体バリデーション補強。
- **L-03** (`scheduler.ts`, `pipeline.ts`, `gateway.ts`, `ec-catalog.ts`): 長寿命インメモリ `Map`/`Set` の TTL・LRU 上限。
- **L-04** (`lib/link/heatmap-render/renderer.ts`, `claim-gates.ts`): SVG `data-sec-fp` 属性 XML エスケープ、PNG 整数寸法ガード、`sd_ms = 0` 時の幅 0 防止。
- **L-05** (`workers/link-zone/zone-worker.ts`): `/_ugk/selftest` の認証または露出情報最小化。

---

## 4. Wave 8 一括是正結果（全 71 / 71 件 完了・検証済）

全 71 件は以下の排他 4 レーンにより 100% 修正・敵対的回帰テスト追加・リポジトリ全体テスト（56/56 スイート・1,089 テスト PASS）・`tsc`・`next build` 検証まで完了済である（詳細は `docs/ugokilink/CODEX_REVIEW_HANDOFF.md` も参照）:

1. **Fix Lane 1（契約・返答封筒・URLキー・SDK・受付・再生）**: `C-04`〜`C-09`, `H-10`〜`H-16`, `M-01`〜`M-03`, `L-01`
2. **Fix Lane 2（認証・分離・SQLパーサ・DDL・WAL/Loader・サンドボックス・波0-A残存）**: `C-01`, `C-10`〜`C-15`, `H-17`〜`H-24`, `M-04`〜`M-08`, `L-02`, `L-03`
3. **Fix Lane 3（行為者・突合・EC・検索・ヒートマップ・AI層）**: `C-02`（`heatmap-image` 側）, `C-03`, `H-25`〜`H-30`, `M-09`〜`M-11`, `L-04`
4. **Fix Lane 4（Surface/OpenAPI/MCP統合・Ask・ML分割・統計・配信・WP・Signer・自律）**: `C-02`（パイプライン統合）, `C-16`〜`C-18`, `H-01`〜`H-09`, `M-12`〜`M-18`, `L-05`
