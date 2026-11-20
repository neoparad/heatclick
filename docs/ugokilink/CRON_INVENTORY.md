# UGOKI LINK v2 定期実行・旧ジョブ棚卸し（CRON_INVENTORY）

- 作成日: 2026-11-20（波 0 / 束 0-B、設計書 §12.4・§13.2 手順 0）
- 対象リポジトリ: `ugokimap-saas`（ブランチ `feat/ugokilink-v2`）
- 調査対象: `vercel.json`, `app/api/cron/**`, `app/api/experiments/pool/route.ts`, `inngest.config.ts`, `middleware.ts`, `workers/*/wrangler.toml`, `.github/workflows/*.yml`, 外部 `app.inngest.com`

> **絶対原則（設計書 §13.2 手順 0・実装計画 §2）**
> 現在稼働中の Vercel Cron 4 本は、新 UGOKI LINK 側の置き換え実装が本番稼働し、下記の停止条件（通過ゲート）を満たすまで**止めない**。先に停止するのは、コード実体を持たない外部 Inngest 旧ジョブ（`heatmap-clickinsight`）と、`inngest.config.ts` 内の旧スタブ記述のみとする。

---

## 1. 定期実行ジョブ全件一覧

### 1.1 Vercel Cron（`vercel.json` 登録済み・稼働中 4 本）

| # | ジョブ / エンドポイント | スケジュール (UTC / JST) | 実装ファイル | 認証方式・現状 | 持ち主（領域） | 新 UGOKI LINK 置き換え先手順 | 停止条件（通過必須ゲート） | 止め方 |
|---|---|---|---|---|---|---|---|---|
| C-1 | `GET /api/cron/daily-site-summary` | `0 17 * * *` (毎日 17:00 UTC / **02:00 JST**) | `app/api/cron/daily-site-summary/route.ts` | `lib/cron-auth.ts` による fail-closed 認証（`CRON_SECRET` ≥16文字の Bearer / `x-cron-secret`）。GET/POST 両対応。`middleware.ts` の `API_PUBLIC_EXACT_PATHS` に完全一致登録済。 | `surf` / `ml`（AI 要約） | **手順 12**（読み取り面・社内 5 画面の `/v1` 付け替え §11.10）＆ **手順 17**（生成モデルによる説明・要約パイプライン §8.12） | `surf.envelope` 通過、社内 5 画面が `/v1` 経由に移行完了、かつ手順 17 の要約成果物ジョブが稼働（`ml.serving_conformance` 通過） | 1. `vercel.json` の `crons` から該当エントリ削除<br>2. `app/api/cron/daily-site-summary/route.ts` を `410 Gone` 化または削除<br>3. `middleware.ts` の `API_PUBLIC_EXACT_PATHS` から削除<br>4. 本番デプロイ |
| C-2 | `GET /api/cron/deep-research` | `*/5 * * * *` (**5 分毎**) | `app/api/cron/deep-research/route.ts` | `lib/cron-auth.ts` による fail-closed 認証（GET/POST 両対応）。`analysis_jobs`（ClickHouse）の `pending` 行を 1 回最大 5 件ポーリング処理。書込ロールは `chat_writer`。 | `surf` / `ml`（Deep Research） | **手順 12**（読み取りカタログの Deep Research ツール・`POST /v1/ask` 非同期ジョブ基盤 §11.11-11）＆ **手順 17**（ML / 生成モデル推論・Inngest オーケストレーション） | `surf.envelope`・`surf.ask_accuracy` 通過、`analysis_jobs` の新規投入がすべて新ジョブキューへ切替完了し残存 `pending` = 0 件 | 1. 新規ジョブ投入停止を確認（`pending = 0`）<br>2. `vercel.json` から削除<br>3. `route.ts` を `410 Gone` 化または削除<br>4. `middleware.ts` の `API_PUBLIC_EXACT_PATHS` から削除 |
| C-3 | `GET /api/cron/fusion-ingest` | `0 */6 * * *` (**6 時間毎** 00/06/12/18 UTC) | `app/api/cron/fusion-ingest/route.ts` | `lib/cron-auth.ts` による fail-closed 認証（GET/POST 両対応）。`FUSION_INGEST_TARGETS` を対象に CRAWL `/v1/fusion/export` を pull し融合 5 表へ INSERT。※**設計書 §5.8・§13.2 注記**: 上流の口（CRAWL 側 export）が BOLA 懸念でマウント解除済のため、現状は実質データが入らない状態。 | `surf` / `join`（CRAWL 連携） | **手順 2**（LINK 単一スケジューラ `SUR M4`・連携許可 `SUR M2`・不変スナップショット契約 `SUR M3`）＆ **手順 13**（構造×行動突合本番化） | `surf.link_grant_active`・`surf.snapshot_contract`・`surf.G1`〜`surf.G4`・`store.G-15` 通過、自社 5 サイトで不変スナップショット pull が稼働 | 1. `FUSION_INGEST_TARGETS` 環境変数を空にして無害化<br>2. `vercel.json` から削除<br>3. `route.ts` を `410 Gone` 化または削除<br>4. `middleware.ts` の `API_PUBLIC_EXACT_PATHS` から削除 |
| C-4 | `GET /api/experiments/pool` | `0 18 * * *` (毎日 18:00 UTC / **03:00 JST**) | `app/api/experiments/pool/route.ts` | **要注意（認証差異）**: `lib/cron-auth.ts` を使わず独自 `isCronAuthorized()` を実装（`VERCEL === '1' && x-vercel-cron === '1'` または `x-cron-secret === CRON_SECRET`）。`middleware.ts` の `API_PUBLIC_PATHS`（prefix 一致）に登録済。POST は JWT + owner/admin + `EXPERIMENTS_POOL_OPERATORS` allowlist。 | `ev`（実験横断プール） | **手順 7**（アロケータ・単一計画表）＆ **手順 20**（無作為試験・複数サイト統合）＆ **手順 27**（横断プール公開登録簿 `ev.G-10`） | `ev.G-1`・`ev.G-3`・`ev.G-10` 通過、新 `unit_ledger` ベースのプール再計算パイプラインが稼働 | 1. `vercel.json` から削除<br>2. 旧 `experiments/pool` の GET cron 経路を停止（POST 運用者口も新 `/v1` 移行後に廃止）<br>3. `middleware.ts` の `API_PUBLIC_PATHS` から削除 |

> **セキュリティ監査メモ（C-4）**: `/api/experiments/pool/route.ts` のみ `lib/cron-auth.ts`（`CRON_SECRET` 必須・constant-time 比較）を使っておらず、`x-vercel-cron: 1` 単体での通過パスが残っている。また `middleware.ts` で prefix 一致公開となっている。本束（0-B）では専有範囲外のため変更せず、統括または波 0-A / 波 2-A の修正候補として `BUILD_LOG` へ記録する。

---

### 1.2 Inngest（リポジトリ内 `inngest.config.ts` および 外部 `app.inngest.com`）

| # | ジョブ / アプリ名 | 場所・スケジュール | 現状 | 持ち主（領域） | 新 UGOKI LINK 置き換え先手順 | 停止条件 | 止め方 |
|---|---|---|---|---|---|---|---|
| I-1 | `ugokimap-saas` (`inngest.config.ts`) | `inngest.config.ts`（`/api/inngest` ルートはリポジトリ内に**未存在**） | **登録関数 = 0 件**（`functions = []`）。束 0-B で旧 Sprint 0〜3 コメントアウトスタブ（`dataQualityCheck`, `dailyBackup`, `executeDeleteRequest`）を撤去し、Wave 4-F / ML 学習オーケストレーション専用のクリーンな枠組みとして定義済。 | `ml`（学習制御面） | **手順 17**（Wave 4-F: テナント別並列制御・外部計算基盤 Cloud Run Jobs / Modal へのジョブ起動制御） | —（新規オーケストレーション専用枠として維持） | 不要（波 4-F で ML 関数のみ登録。監視・バックアップ・削除は一切 Inngest に載せない） |
| I-2 | 旧 `dataQualityCheck`（旧スタブ） | 旧 `inngest.config.ts` コメント（`0 * * * *`） | 未登録・コード削除済。監視対象と同じ Vercel 上で動かすと障害時に共倒れするため不採用。 | `store` | **手順 4**（STORE M13 閉包 1〜4 + 独立 Worker cron watchdog 5 分監視）＆ **手順 9**（閉包 5: 毎時カナリア訪問 `sdk_canary_visit`） | 撤去済（登録 0 件） | 束 0-B にて `inngest.config.ts` から削除済 |
| I-3 | 旧 `dailyBackup`（旧スタブ） | 旧 `inngest.config.ts` コメント（`0 18 * * *`） | 未登録・コード削除済。Vercel から SSH 鍵を保持してバックアップする設計はセキュリティ上禁止。 | `store` | **手順 4**（ClickHouse プライベートネットワーク内ストアエージェントの日次バックアップ＆月次リストア訓練 `store.G-4`） | 撤去済（登録 0 件） | 束 0-B にて `inngest.config.ts` から削除済 |
| I-4 | 旧 `executeDeleteRequest`（旧スタブ） | 旧 `inngest.config.ts` コメント（event: `delete-request/scheduled`） | 未登録・コード削除済。 | `store` / `surf` | **手順 4・手順 12**（STORE M8 削除計画: 日次マスク ≤24h・週 2 回物理パージ ≤5d・14 日以内証明 `store.G-10`） | 撤去済（登録 0 件） | 束 0-B にて `inngest.config.ts` から削除済 |
| I-5 | 旧 `heatmap-clickinsight`（`warm-heatmap-cache` 等） | **外部 `app.inngest.com` 上に残存**（旧 `ugokimap` リポジトリ由来。6 時間毎に重い ClickHouse クエリを約 300 本発行する構成） | 本リポジトリ外で稼働中の可能性あり。本番 4.54 GiB ClickHouse のメモリ超過（Code 241）直接原因候補。 | オーナー（インフラ運用） | 廃止（新設計では手順 4 の確定集計 `sealed rollups`＋エッジ直近集計 `edge_live` に置換、キャッシュ事前ウォームアップ不要） | **即時停止可**（コード依存なし） | **オーナー作業（`OWNER_TODO.md` §2）**: `app.inngest.com` 管理画面にログインし、旧アプリ `heatmap-clickinsight` の全関数（`warm-heatmap-cache` 等）を Pause / Delete、不要なアプリ連携を削除 |

---

### 1.3 Cloudflare Workers および GitHub Actions の定期実行調査結果

| 種別 | 調査対象ファイル | 定期実行 (`crons` / `schedule`) 件数 | 備考・今後の予定 |
|---|---|---|---|
| Cloudflare Worker (`ugokimap-event-ingest`) | `workers/event-ingest/wrangler.toml` | **0 件** | HTTP 受信専用。手順 11（並行稼働 `tel.G18`）および手順 30（切替 `store.G-20`）完了後に廃止。 |
| Cloudflare Worker (`ugokimap-banner-runtime`) | `workers/banner-runtime/wrangler.toml` | **0 件** | HTTP 配信専用（旧 KV 参照）。手順 18〜19（新配信ランタイム＋強い整合性 `ctl`）へ移行後に廃止。 |
| Cloudflare Worker (`ugokimap-screenshot`) | `workers/screenshot/wrangler.toml` | **0 件** | Browser Rendering 呼び出し専用。手順 5 の第 2 描画環境（`surf.second_executor`）および手順 12 のヒートマップ描画（§11.12）の参考流用元。 |
| GitHub Actions | `.github/workflows/contracts-test.yml`, `partner-hosts-validate.yml`, `sentry-release.yml` | **0 件** | いずれも `push` / `pull_request` / `deployment_status` のイベント起動のみで `schedule:` 定義なし。 |
| 新設予定（参考） | `workers/link-watchdog`（手順 4）・LINK 単一スケジューラ（手順 2）・ストアエージェント（手順 4） | — | 新 UGOKI LINK では Vercel 外の独立 watchdog Worker cron、単一スケジューラ、プライベートネットワーク内ストアエージェント、および Inngest（Wave 4-F ML 学習専用）に責務を明確分離する。 |

---

## 2. 停止手順の標準チェックリスト（将来の切替時）

稼働中の Vercel Cron（C-1〜C-4）を実際に停止する際は、必ず以下 5 ステップを順に実施する。

1. **ゲート確認**: `GET /v1/sites/{id}/capabilities`（ゲート台帳 `packages/contract/ledgers/gates.ts`）で、該当ジョブの停止条件ゲートがすべて `open` であることを確認する。
2. **並行確認**: 新経路が最低 7 日間（切替・課金系は 30 日間）エラー 0・欠損許容内で稼働していることを確認する。
3. **スケジュール解除**: `vercel.json` の `crons` 配列から該当エントリを削除する。
4. **エンドポイント封鎖**: 対象 `route.ts` を `410 Gone` 応答へ変更（または削除）し、`middleware.ts` の `API_PUBLIC_EXACT_PATHS` / `API_PUBLIC_PATHS` から該当パスを除去する。
5. **監査記録**: 停止日時・最終実行結果・確認ゲート ID を `docs/ugokilink/BUILD_LOG.md` に記録する。
