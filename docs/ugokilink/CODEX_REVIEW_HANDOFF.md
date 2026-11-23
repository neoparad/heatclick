# UGOKI LINK v2 — Codex レビュー引き継ぎ＆全作業総括書（CODEX_REVIEW_HANDOFF）

- **作成日**: 2026-11-22
- **対象リポジトリ**: `c:\Users\M2603\ugokimap-saas`
- **対象ブランチ**: `feat/ugokilink-v2`（起点ブランチ: `claude/inngest-clickhouse-review-c87b69` コミット `683203b`、ローカルのみ・未 push）
- **正本仕様・計画書**:
  1. 正本設計書: `docs/proposals/2026-11-19-ugokilink-master-architecture-v2.md`（§0〜§18）
  2. 引き継ぎ入口: `docs/proposals/2026-11-20-ugokilink-antigravity-handoff.md`
  3. 実装計画本編: `docs/proposals/2026-11-20-ugokilink-implementation-plan.md`（特に §1 原則・§2 触らないもの）
  4. ML/LLM 追加計画: `docs/proposals/2026-11-20-ugokilink-implementation-plan-addendum-ml.md`（束 `4-F`・`4-G`・`4-H`・`6-F`）
- **成果物レポート・運用台帳**:
  - `docs/ugokilink/COMPLETION_REPORT.md` — 全 32 束・ゲート開閉・VRAM 試算・未検証事項の完了報告
  - `docs/ugokilink/REVIEW_REPORT.md` — 独立 4 スライス敵対的レビューで検出した全 71 件と Wave 8 是正記録
  - `docs/ugokilink/BUILD_LOG.md` — 設計具体化・仕様裁定の判断ログ
  - `docs/ugokilink/OWNER_TODO.md` — 人間にしかできない作業（契約・法務署名・鍵儀式・本番適用）
  - `docs/ugokilink/CRON_INVENTORY.md` — 旧 Inngest / Cron 全棚卸しと停止状況
  - `docs/ugokilink/CUTOVER_RUNBOOK.md` — 並行稼働 → 直接 R2 影書込 → 旧 9 資産停止ランブック

---

## 1. 今回の一連の作業の全体像（Wave 0 〜 Wave 8）

本セッションでは、正本設計書 v2 および実装計画に従い、以下の **3 フェーズ** をローカルブランチ `feat/ugokilink-v2` 上で完遂した。

### Phase A: 波 0 〜 波 7（全 32 束）の本実装
「ページ構造（LINKTH CRAWL）× 人間の行動 × AI（クローラー／ブラウザ操作 AI）の挙動 × 売上（アフィリエイト＆物販 EC）」を単一 URL キー（`urlkey/2`）と共通区画 ID で結び、観測 → 保存 → 統計/ML/LLM → 因果実験 → 閉じた文法による施策配信・推薦までを一気通貫で動かすヘッドレス意思決定基盤 **UGOKI LINK v2** の全 32 束を実装した。

| 波 | 実装した束 | 主な実装内容 |
|---|---|---|
| **波 0（止血・時計）** | `0-A`, `0-B`, `0-C`, `0-D` | 本番 API のモック/ダミーフォールバック 29 箇所撤去、既存クエリの `tenant_id` バインド強制、公開 `tracking.js` のクエリ文字列 PII 除去、旧 Inngest 登録 0 化、読み取り専用の本番ベースライン採取スクリプト（`scripts/link/inspect-prod-baseline.mjs`）、24 公式ソースの AI クローラー IP/JWKS 時計スナップショット（`lib/link/clocks/`）。 |
| **波 1（単一契約）** | `1-A`, `1-B`, `1-C`, `1-D`, `1-E` | 単一正本スキーマ `CANONICAL_SCHEMA` と 6 つの決定論的生成器（SDK コーデック・受付検証器・ClickHouse DDL・PostgreSQL DDL・TS 型・開示/14 日削除計画）、4 台帳（236 ゲート・88 定数・21 不可知・34 判断［`D-31b` 永久ロック含］）、360 ベクトル適合 `urlkey/2`、外部依存ゼロ HTML 区切り器（220 ページ DOM 一致）、不変条件 I1〜I7 を強制する共通返答封筒（`VerifiedMetricValue` / `UntrustedValue`）。 |
| **波 2（分離・保存・署名）** | `2-A`, `2-B`, `2-C`, `2-D` | 4 種鍵（`ugk_pub_*`, `ugk_sec_*`, OAuth DPoP, OEM 交換トークン）・リスク階層 R0–R5・2 層テナント分離（SQL 字句/AST 検査 ＋ ClickHouse/Postgres 行ポリシー）・672 ケース越境 404 マトリクス・`LinkGrant`・5 段階スケジューラ、R2 WAL・単一書込 `ShardLoader`（10 万通り可換べき等マージ・168h WAL 完全再構築）・1h 確定集計・8 GiB 予算・14 日削除エンジン、第 2 描画環境＆CRAWL 契約スタブ、オフライン Ed25519 署名・固定スニペット・Zone Worker・WordPress Companion プラグイン・行為者盲目アロケータ。 |
| **波 3（計測・行為者・並行）** | `3-A`, `3-B`, `3-C`, `3-D`, `3-E` | 非干渉ブラウザ SDK・5 同意モード・受付 Worker（部分受理・Queue 後 ACK / R2 退避 / 503・急増遮断器）、Segment 6 種互換・顧客定義イベント、統一検査印（6 目的・アフィリエイト Lab Sink・6 パイプライン除外）、RFC 9421 / SAIL / FCrDNS / 署名ログ 5 種 / Origin Kit 4 種 / E・T・P アドレス保護、直近 30 分 Durable Object 集計・並行稼働 11 種損失台帳・旧データ橋渡し・TOST 較正。 |
| **波 4（API・出力・突合・ML/LLM・絵）** | `4-A`〜`4-I`（9 束） | REST/MCP 統合パイプライン・OpenAPI 3.1・社内 5 画面アダプタ、倉庫 5 種＋Parquet・ストリーム 4 種・隔離関数サンドボックス・RO SQL 口・セルフサーブ課金、8 言語サーバー SDK 生成器・`POST /v1/ask`（1,000 問評価束）、構造×行動突合・アフィリエイト `join.G13`・物販 EC カタログ/粗利分離/会員要約、GSC/GA4・Fréchet/Manski 上下限・AI 検索探針、ML 基盤（点時点漏れ遮断・引換券・≤50KB `int8` 木）、生成モデル層（Muse Glimmer 30B / Gemma 4 両対応・Jev 公開文専用閉鎖クライアント・自前数字検証器）、追加学習経路 §8.14（盲検 κ・`D-31b` Jev 0 件機械検査・Union-Find 3 分割・仕事別 LoRA・自前蒸留）、決定論的 PNG ヒートマップ描画サービス（§11.12 全 6 ゲート）。 |
| **波 5（配信・因果実験）** | `5-A`, `5-B`, `5-C` | 影配信 A0・SDK 重量 TOST、閉じた文法ランタイム（2.55 KB gzip・`innerHTML`/`eval` ゼロ）・K1–K4 自動停止・エッジ判断 Worker・`POST /v1/decisions`、事前登録ロック・α 分割・CUPED・1,000 回プラセボ・LORD++ オンライン FDR・mSPRT 逐次検定・5 経路 `proven` 判定。 |
| **波 6（高度モデル・推薦・自律）** | `6-A`〜`6-F`（6 束） | Gamma-Poisson＋BH 超過離脱検出・学習セグメント、ブラウザ内ローカル AI 尤度比＆証明書・非混合 4 計器・AI 検索 8 段階台帳、変更効果台帳・ページ単位無作為展開・1 万回適応配分検定、メディア＆物販 EC 完全推薦（在庫即時除外・購入済/カート除外・合わせ買い・再購入周期・ログイン会員合流・Plackett-Luce 周辺確率）・アシスタント 3 段・`POST /v1/recommend`、ポップアップ時期 3 段＆選択 5 段、パスキー封入自律枠・エージェント公開 1,040 件乗っ取り防御・連合学習。 |
| **波 7（OEM・再生・モバイル・切替）** | `7-A`〜`7-F`（6 束） | 外部テナント受入・OEM 管理・100 万件公開キー洪水課金防御、画面付き再生 Tier 3（送信前マスク・AES-256-GCM AAD・空 `sandbox` 隔離再生・カナリア漏れ 0）、モバイル 4 言語 SDK（Swift / Kotlin / RN TS / Flutter Dart）、11 保存役割地域監査・OSS 境界監査、30 日直接 R2 影書込・旧 9 資産停止状態機械、`env.example` 34 変数・横断 E2E 統合試験。 |

### Phase B: 独立 4 スライスによる敵対的コード＆アーキテクチャ監査
全 32 束の実装完了後（`ca0bb1c`）、実装担当エージェントの自己申告を一切信頼せず、読み取り専用の敵対的レビュアー 4 スライスで全変更ファイルを精査した。結果、単体テストのモックや自己完結入力の陰に隠れていた **計 71 件（Critical 18 件・High 30 件・Medium 18 件・Low 5 件）** の接合不整合・認可バイパス・SQL/VM 脱出・統計エッジケースを特定し、`docs/ugokilink/REVIEW_REPORT.md` に全件の再現条件と行番号を記録した。

### Phase C: Wave 8 — 全 71 件の一括是正と横断再検証
共通契約型を `packages/contract/schema/types.ts` に固定した上で、排他 4 レーンにより **71 件すべてを省略・スタブ無しで完全修正**し、各攻撃ペイロード・境界条件を直接叩く敵対的回帰テスト（+131 テスト）を追加した。

---

## 2. アーキテクチャ・ディレクトリ構成マップ（Codex 監査用）

| レイヤ | パス | 役割・主な確認ポイント |
|---|---|---|
| **単一契約・台帳** | `packages/contract/{schema,ledgers,urlkey,segmenter,response}/` | `CANONICAL_SCHEMA`、DDL/型/削除計画生成器、4 台帳（`D-31b` ロック）、`urlkey/2`、HTML 区切り器、`WeakSet` ブランド返答封筒 |
| **クライアント SDK・WP** | `packages/{sdk-snippet,sdk-browser,sdk-runtime,sdk-mobile,sdk-server,wp-plugin}/` | Ed25519 自己完結スニペット、ブラウザ計測 SDK、閉じた文法ランタイム、モバイル 4 言語生成器、サーバー 8 言語 SDK 生成器、WP 2 鍵プラグイン |
| **エッジ / 非同期 Worker** | `workers/{link-collector,link-wal,link-loader,link-live,link-signer,link-zone,link-decision}/` | 受付 Worker、テナント物理分離 R2 WAL、可換べき等 `ShardLoader`＆1h 確定集計、30 分 Live DO、Ed25519 Signer CAS、Zone Worker、エッジ判断 Worker |
| **コアエンジン群** | `lib/link/{auth,isolation,linkage,scheduler,store,migration,export,oem,residency,cutover,replay}/` | 4 種鍵・`AuthorizationGateway`（R0–R5）、SQL トークナイザ＆AST 検査・行ポリシー、128-bit SSRF 防御、使い捨て `worker_threads` サンドボックス、14 日削除エンジン、Replay Tier 3 |
| **分析・AI・収益・絵** | `lib/link/{clocks,actors,lab,join,revenue,search,heatmap-render,ai-layer}/` | RFC 9421 検証・Origin Kit、第 2 描画環境、物販 EC カタログ/会員ストア、`rev.G13`、Fréchet-Manski・AI 検索探針、決定論 PNG ヒートマップ＋RREF 差分防御、ローカル AI 証明書 |
| **Surface・ML・因果・配信** | `lib/link/{surface,ask,ml,models,allocator,delivery,evidence,rollout,autonomy}/` | 単一 `SurfacePipeline`・OpenAPI 3.1・MCP、`POST /v1/ask`、ML 基盤・Muse/Gemma 層・Jev 閉鎖クライアント・LoRA 3 分割、EC/記事推薦・ポップアップ、LORD++/mSPRT、自律公開ゲート |
| **Next.js ルート＆境界** | `middleware.ts`, `app/api/v1/**/route.ts`（全 20 ルート） | `middleware.ts` の `'api-v1-link'` 委譲＆偽装ヘッダ除去、`OPERATION_CATALOG` 26 操作と 1:1 対応する全 20 ルート |
| **生成 DDL** | `migrations/link/{001_clickhouse_v2.sql,002_postgres_v2.sql}` | ClickHouse 33 テーブル＋5 公開 `v_*` ビュー（MV/Projection 0 件）、PostgreSQL 制御プレーン（PERMISSIVE + RESTRICTIVE `FORCE ROW LEVEL SECURITY`） |
| **横断 E2E・止血監査** | `tests/unit/{ugokilink-v2-integration,wave0-no-dummy-and-tenant-guard}.test.ts` | 無変換 Collector→WAL→Loader 直結 E2E、保留テスト 0・`.env` 非参照・`D-31b`・全 `/api/v1` ルート偽装ヘッダ/ダミー 0 静的監査 |

---

## 3. Wave 8 で修正した重要急所（Codex に重点レビューしてほしいポイント）

`docs/ugokilink/REVIEW_REPORT.md` の全 71 件のうち、特に攻撃耐性・データ整合性に直結する **Critical 18 件＋主要 High 修正箇所** の監査ポイントを以下に整理する：

1. **認証・API 境界の一貫性 (`C-01`, `C-02`, `H-01`, `H-02`, `M-15`)**:
   - `middleware.ts` が `/api/v1/**` を `'api-v1-link'` として旧人間用 HS256 JWT から分離しつつ、外部から注入された `x-ugk-*` / `x-user-*` / `x-site-ids` ヘッダを確実に剥がしているか。
   - `app/api/v1/sites/[siteId]/heatmap-image/route.ts`・`app/api/v1/mcp/route.ts`・`recommend` を含む全 20 ルートが `IdentityKeyRegistry` + `AuthorizationGateway` を通り、本番で `UGOKILINK_KEY_PEPPER` 未設定時に `503` で fail-closed するか。
   - `OPERATION_CATALOG`（26 操作）と `app/api/v1/**/route.ts`（20 ファイル）・OpenAPI 3.1・MCP・8 言語 SDK の間に漏れや不整合が残っていないか。
2. **SQL 分離・サンドボックス・SSRF (`C-10`, `C-11`, `C-12`, `H-17`, `M-06`)**:
   - `lib/link/isolation/ast-inspector.ts` と `lib/link/export/sql-interface.ts` の状態機械 SQL 字句解析器が連続バックスラッシュ `'\\'`＋`'\''`・コメント・識別子クォートで破綻せず、全 `SELECT` スコープで最上位 `OR`・文字列定数バインド偽装・`UNION`・カンマ結合・`system.*` を拒否できているか。
   - `lib/link/export/destination-functions.ts` の使い捨て `node:worker_threads`（`resourceLimits` + `env: {}` + ホストオブジェクト注入ゼロ `vm` + `codeGeneration: { strings: false, wasm: false }`）からホスト `process` や他テナントメモリへ到達できないか。
   - `lib/link/linkage/types.ts` の 128-bit IP パーサが 16 進 IPv4-mapped IPv6（`::ffff:7f00:1`, `::ffff:a9fe:a9fe`）・NAT64・6to4・8 進/整数 IPv4 やリダイレクト認証ヘッダ漏洩を完全に塞いでいるか。
3. **ClickHouse / PostgreSQL DDL と WAL / Loader / 削除連鎖 (`C-05`, `C-14`, `C-15`, `H-15`, `H-18`, `H-19`, `H-21`)**:
   - `migrations/link/001_clickhouse_v2.sql`（`frame_quarantine` 非 Nullable キー、短期 TTL テーブルの日次パーティション、`ugk_ro_<sha256_32>` で統一された PERMISSIVE + RESTRICTIVE 行ポリシー、5 公開 `v_*` ビュー）と `002_postgres_v2.sql`（PERMISSIVE + RESTRICTIVE 両出力の `FORCE ROW LEVEL SECURITY`）が実 DB で構文エラーや 0 件ロックアウトを起こさないか。
   - `workers/link-collector` が送出する `PersistedCollectorRecord` が無変換で `WalWriter` → `ShardLoader` → `SealedRollupBuilder` に流れ、WAL オブジェクトが `(tenant_id, site_id, shard_id, minute_utc)` ごとに物理分離され、RFC 2104 HMAC による 14 日削除墓標が WAL 再構築時にも復活を阻止しているか。
4. **秘匿・差分推論攻撃防御 (`C-03`, `H-03`, `H-25`, `M-06`)**:
   - `lib/link/heatmap-render/service.ts` と `lib/link/ask/{ask-service,pre-llm-filter}.ts` において、`< 10` 抑制セルの全実数フィールド `null` 化、相補的二次抑制（合計からの引き算特定防止）、キャッシュ参照前の開示判定、期間ずらしおよび 3〜4 クエリ線形結合（RREF ガウス消去）に対する差分防御が数学的に閉じているか。
5. **暗号・信頼連鎖・自律公開 (`C-04`, `C-06`, `C-07`, `C-13`, `C-16`, `C-17`, `C-18`, `H-08`, `H-26`)**:
   - `collector` の 32 hex 定数時間 MAC・`CF-Connecting-IP` 導出・30 分 `pv_token`、スニペットの自己完結 WebCrypto Ed25519 検証＆厳密 Trusted Types、`brand.ts` の閉包 `WeakSet` による `VerifiedMetricValue` 偽造不能性、`enforceR4` のパスキー消費、`agent-publisher.ts` の網羅 `switch` fail-closed＋機械 URL/価格検査、WordPress ローカル `wp_options` 承認ハッシュによる真の 2 鍵、Signer の強整合 `BundleStateStore` CAS、RFC 9421 の `@method`/`@authority`/`@path`/`@query` 拘束と JWKS ピン留め。
6. **統計・ML・Jev 永久禁止 (`H-04`〜`H-07`, `H-30`, `M-09`〜`M-14`, `M-18`)**:
   - `D-31b`（Jev 出力の学習・重み・蒸留先生利用の永久禁止）が深さ無制限の反復グラフ走査（`WeakSet` 循環防止＋10 万ノード上限 fail-closed）および `dataset-builder.ts` の先頭検査でバイパス不能か。
   - 重複削除前 Union-Find による 3 分割リーク防止、Unicode MinHash、注水法（water-filling）による重み上限 `<= 0.05` と適応配分シンプレックス射影の冪等性、LORD++ の初回棄却報酬 $(\alpha - W_0)$ と全履歴和、Johari mSPRT の継続覗き見 Type I エラー制御、Plackett-Luce 周辺表示確率、同時 Wilson 区間と 60 次元ガウス対数正規化定数。

---

## 4. 絶対禁止事項（実装計画 §2）の遵守ステータス

Codex 監査時に併せて検証できるよう、実装計画 §2 の制約遵守状況を明記する：

1. **本番環境非接触**: 本番 ClickHouse / PostgreSQL への DDL 適用・データ変更・Vercel / Cloudflare へのデプロイ・`git push` は **一切行っていない**。
2. **秘密情報非接触**: `.env*` ファイルの読み取り・編集・ステージングは **0 件**（`env.example` への変数名・説明追記のみ）。
3. **作業資料・無関係差分の保護**:
   - `docs/proposals/2026-11-19-ugokilink-v2-working/` は `.git/info/exclude` により未コミット保護され、本番コードからの参照も 0 件。
   - 起点前からワークツリーにあった無関係な変更 `docs/handoff/antigravity-fusion/LINKSCRAWL_CAPABILITIES_2026-11-04.md` には一切触れておらず、未ステージのまま保持している。
4. **意図的に閉鎖しているゲート**: 実データ蓄積・法務署名・GPU 配備が必要なゲート（`2.2` 一覧: `COMPLETION_REPORT.md` 参照）はダミー値で開けず、`not_entitled` / `challenger` / `not_collected` として正直に閉鎖している。

---

## 5. Codex 実行用の検証コマンド一式

```powershell
# 1. 起点コミット (683203b) からの全コミット履歴と変更統計の確認
git log --oneline 683203b..HEAD
git diff --stat 683203b..HEAD

# 2. UGOKI LINK v2 全 56 スイート (1,089 テスト) 一括実行
npx jest packages/contract packages/sdk-browser packages/sdk-snippet packages/sdk-mobile packages/sdk-runtime packages/sdk-server packages/wp-plugin workers/link-collector workers/link-wal workers/link-loader workers/link-live workers/link-signer workers/link-zone workers/link-decision lib/link middleware.classify.test.ts __tests__/api-utils.test.ts app/api/scenarios/runtime/route.test.ts tests/unit/wave0-no-dummy-and-tenant-guard.test.ts tests/unit/ugokilink-v2-integration.test.ts

# 3. 0-C 本番調査スクリプト単体試験 & 既存 event-ingest Worker 回帰試験
node --test scripts/link/inspect-prod-baseline.test.mjs
npm test --prefix workers/event-ingest

# 4. リポジトリ全体 TypeScript 厳格型検査 & Next.js 本番ビルド
npm run type-check
npm run build
```

---

## 6. Codex にそのまま渡せるレビュー依頼プロンプト例

```text
ブランチ `feat/ugokilink-v2`（起点 `683203b`）で実装・一次是正された UGOKI LINK v2 について、独立した第三者として厳格な敵対的コード＆アーキテクチャレビューを実施してください。

【読むべき順番】
1. `docs/ugokilink/CODEX_REVIEW_HANDOFF.md`（今回の一連の作業総括と監査急所マップ）
2. `docs/proposals/2026-11-19-ugokilink-master-architecture-v2.md`（正本設計書 §0〜§18）
3. `docs/proposals/2026-11-20-ugokilink-implementation-plan.md`（§1 原則・§2 絶対禁止事項）および `docs/proposals/2026-11-20-ugokilink-implementation-plan-addendum-ml.md`
4. `docs/ugokilink/REVIEW_REPORT.md` および `docs/ugokilink/COMPLETION_REPORT.md`

【レビュー方針】
- レポートの自己申告を鵜呑みにせず、`git diff 683203b..HEAD` の実コード・生成 DDL・境界条件・数式を直接検証してください。
- 特に (1) テナント分離・認可バイパス・ヘッダ偽装、(2) SQL 字句/AST 検査・`worker_threads` サンドボックス・128-bit SSRF、(3) Collector↔WAL↔Loader↔Deletion のデータ契約と ClickHouse/Postgres DDL の実運用整合、(4) `<10` 秘匿・相補的二次抑制・RREF 差分推論防御、(5) 暗号署名・WP 2鍵・Signer CAS・自律公開ゲート、(6) `D-31b` Jev 永久禁止ロックと統計/ML 数理（LORD++, mSPRT, Union-Find 分割, Plackett-Luce, Wilson/ガウス境界）、(7) Wave 8 修正による退行や二次バグの有無 を重点的に監査し、Critical / High / Medium / Low に分類してファイル名・行番号・再現条件とともに報告してください。
- なお、実装計画 §2 の禁止事項（本番 DB/デプロイ接触禁止、`git push` 禁止、`.env*` 読み書き禁止、`docs/handoff/antigravity-fusion/LINKSCRAWL_CAPABILITIES_2026-11-04.md` 変更禁止）は厳守してください。
```


---

## 7. Wave 9: Codex 第 1 回レビュー（`13a3b09`）指摘 30 件の全件是正マトリクス

Codex 第 1 回レビュー（High 24 / Medium 5 / Low 1 = 計 30 件）に対し、全 30 件を修正・回帰テスト追加・DDL 決定論再生成・全 56 スイート（1,122 テスト）・`tsc`・`next build` まで完了した：

| # | 重要度 | 指摘内容 | 修正ファイル | 検証テスト |
|---|---|---|---|---|
| 1 | High | サイト限定資格情報の SQL サイト述語強制 | `lib/link/isolation/{ast-inspector,query-builder}.ts`, `lib/link/export/sql-interface.ts` | `isolation.test.ts`, `export.test.ts`（2 サイト実行検証） |
| 2 | High | RFC 9449 署名付き DPoP 実検証（`x-dpop-jkt` 単独信用廃止） | `lib/link/auth/keys.ts`, `lib/link/surface/{http-adapter,pipeline,mcp}.ts`, `app/api/v1/{decisions,sites/[siteId]/heatmap-image}/route.ts` | `auth.test.ts`, `surface.test.ts`, `decision.test.ts` |
| 3 | High | 自律公開で承認検証器未注入時に fail-closed | `lib/link/autonomy/agent-publisher.ts` | `autonomy.test.ts`（`APPROVAL_VERIFIER_REQUIRED`） |
| 4 | High | カタログ列挙値も封印済み envelope 許可種別と突合 | `lib/link/autonomy/{agent-publisher,autonomous-envelope}.ts` | `autonomy.test.ts` |
| 5 | High | Signer 既定インメモリ CAS 廃止・共有ストア必須化 (`503`) | `workers/link-signer/{worker,signer}.ts` | `signer.test.ts`（別 handler 競合 `[200, 409]`） |
| 6 | High | WP 2 鍵判定を全文 before/after HTML 比較化（H1 本文のみ変更を捕捉） | `packages/wp-plugin/{ugokilink-companion.php,contract.ts}` | `wp-plugin.test.ts`, `rollout.test.ts` |
| 7 | High | WP 承認消費（`unused→claimed→consumed`）と投稿更新の不可分・失敗時回復 | `packages/wp-plugin/{ugokilink-companion.php,contract.ts}` | `wp-plugin.test.ts`（同時配送＋更新失敗ロールバック） |
| 8 | High | `/v1/optout` の Cookie 設定と永続削除受付の分離（非永続で `deletion_queued:true` 禁止） | `workers/link-collector/worker.ts` | `collector.test.ts`（Wave 9 `#8`） |
| 9 | High | 会員識別子 HMAC の共通版付き関数統一（過去形式・旧鍵候補含む） | `packages/contract/schema/hash.ts`, `workers/link-collector/{collector,worker}.ts`, `lib/link/store/deletion-engine.ts` | `schema.test.ts`, `collector.test.ts`（収集→消去往復） |
| 10 | High | Loader 引き継ぎ時に manifest 順 WAL 再生で旧 PV 状態を復元 | `workers/link-loader/loader.ts` | `loader.test.ts`（Wave 9 `#10`） |
| 11 | High | 誤リージョン配送の現地隔離保存禁止（§11.11.13 準拠・再配送/retry） | `workers/link-wal/wal-writer.ts` | `wal.test.ts`（Wave 9 `#11`） |
| 12 | High | Tier 2 顧客 export 受領の永続管理と主系重複時の冪等再送 | `workers/link-wal/storage-adapter.ts` | `wal.test.ts`（Wave 9 `#12`） |
| 13 | High | 隔離削除・期限掃除の 1,000 件超 `cursor` 全ページ走査 | `workers/link-wal/{wal-writer,storage-adapter}.ts` | `wal.test.ts`（Wave 9 `#13` 1,050 件超） |
| 14 | High | ClickHouse `TTL exp_week` 修正（余分な `+ INTERVAL 7 DAY` 削除＋DDL 再生成） | `packages/contract/schema/canonical.ts`, `migrations/link/001_clickhouse_v2.sql` | `schema.test.ts`, `loader.test.ts` |
| 15 | High | 外部 403 拒否理由から秘匿件数・差分値を完全除去 | `lib/link/heatmap-render/service.ts` | `heatmap-render.test.ts`（`[#15]`） |
| 16 | High | 秘匿クリックの `rel_x`/`rel_y` を `null` 化＆PNG/SVG 点描画除外 | `lib/link/heatmap-render/{types,service,renderer}.ts` | `heatmap-render.test.ts`（`[#16]`） |
| 17 | High | Ask の開示予定全グループ行＋合計を RREF へ原子バッチ投入 | `lib/link/ask/pre-llm-filter.ts` | `ask.test.ts`（`[#17]` 同和集合 1 人入替検知） |
| 18 | High | Ask キャッシュ参照前に現在同意判定＋キャッシュキーへ同意モード追加 | `lib/link/ask/ask-service.ts` | `ask.test.ts`（`[#18]`） |
| 19 | High | マスク領域・未保証由来 OCR 文字列の完全除外 | `lib/link/heatmap-render/{types,service}.ts` | `heatmap-render.test.ts`（`[#19]`） |
| 20 | High | 記事推薦両分岐で Plackett-Luce 真の周辺表示確率（`2/3`）を返却 | `lib/link/models/recommend-service.ts` | `recommend-assistant.test.ts`（`[#20]`） |
| 21 | High | `always_valid` mSPRT で推定量分散必須化（`0.01` 暗黙規定廃止） | `lib/link/evidence/experiment-engine.ts` | `evidence.test.ts`（`[#21]`） |
| 22 | High | LORD++ の `experimentId` 単位冪等記帳（矛盾再送は拒否） | `lib/link/evidence/experiment-engine.ts` | `evidence.test.ts`（`[#22]`） |
| 23 | High | 単一サイト学習コーパスの 3 分割修復（系譜・近重複・実験境界＋空分割拒否） | `lib/link/ml/finetune/dataset-builder.ts` | `finetune.test.ts`（`[#23]`） |
| 24 | High | Jev 日本語評価ゲートを `(質問カテゴリ, モデル版)` 別管理へ厳格化 | `lib/link/ml/llm/jev-client.ts` | `llm.test.ts`（`[#24]`） |
| 25 | Medium | 承認消費を冪等キャッシュ照会・レート制限通過後へ遅延 | `lib/link/auth/{types,gateway}.ts`, `lib/link/surface/pipeline.ts` | `auth.test.ts`, `surface.test.ts` |
| 26 | Medium | Worker 内 32 KiB 出力＆512 B エラー制限を IPC 転送前に強制 | `lib/link/export/destination-functions.ts` | `export.test.ts` |
| 27 | Medium | Postgres 保持月数グリッド `CHECK` 制約生成＋ランタイム検証器 | `packages/contract/schema/{ddl-generator,invariants}.ts`, `migrations/link/002_postgres_v2.sql` | `schema.test.ts` |
| 28 | Medium | Wilson 下限 > 事前上限の空共通部分を `assumption_inconsistent` として検知 | `lib/link/ai-layer/local-ai-scorer.ts` | `ai-layer.test.ts`（`[#28]`） |
| 29 | Medium | ガウス尤度比計算前の 60 次元一致・有限・正分散強制 | `lib/link/ai-layer/local-ai-scorer.ts` | `ai-layer.test.ts`（`[#29]`） |
| 30 | Low | SSRF 予約帯判定から `TEST-NET-2/3` 例外を撤去 | `lib/link/linkage/grant-service.ts` | `linkage.test.ts`, `export.test.ts` |
