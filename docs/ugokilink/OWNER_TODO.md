# UGOKI LINK v2 オーナー作業一覧（OWNER_TODO）

エージェントが実行しない作業（本番適用・鍵・外部手続き・自社5サイト作業・オーナー判断 1〜31）をここに集約する。

---

## 1. オーナー判断（設計書 §14 判断 1〜31）

### 期限つき・最優先（計測開始前〜30日以内）
- [ ] **判断 1（同意のモード・日本の外部送信規律）**: 日本の法域行（告知＋オプトアウトで長期訪問者IDを使う形、およびセッション限りの表示回数カウントの扱い）を法務確認・署名。署名まで自社5サイトは `cookieless`（PV単位のみ）。
- [ ] **判断 2（本番通信での計測タグ比較群）**: 最小版／軽量版／全部版および旧新並行稼働・2秒監査群の無作為割当を承認（全部版を「検証専用：配信可＝半々」か「全部を検証専用」か決定）。
- [ ] **判断 3（自社5サイトのゾーン Worker 配備）**: 各サイトの CDN・CMS・ホスティング構成を確定し、自社 Cloudflare アカウントへ `workers/link-zone` を配備。
- [ ] **判断 4（WordPress プラグイン）**: 新規製品部品としての導入承認と自社サイト設置。
- [ ] **判断 5（専用 8 GiB 級 ClickHouse サーバー）**: 新保存用の専用サーバー確保と、旧システム停止日の設定。
- [ ] **判断 6（決定記録先の一本化・規則ファイル更新）**: 親戦略文書の決定ログを唯一の正とし、ヘッドレス転換および `CLAUDE.md` 規則3（VWO委譲廃止・他テナント404化）を更新記録。
- [ ] **判断 8（録画禁止 D-11R の条項別承認）**: `(a)(b)(e)(f)(g)` を先行承認（`(b)` は計測開始から30日以内）、`(c)(d)(h)` は法務確認後。
- [ ] **判断 12（アドレスの扱い H-8 改定・3分類）**: プライバシー告知更新と、サーバー側証明優先・決定的証拠のみ除外の承認。
- [ ] **判断 14（保持・削除・R2 正本 I-1/I-2/I-7）**: R2 を保持期間内の生データ正本とし、24時間非表示・5日物理消去・14日証明・保持刻み選択を承認。
- [ ] **判断 29（保存の地域）**: データ所在地域の既定・選択肢を決定。

### 既に決定済み（2026-11-20 オーナー回答：判断 31 等）
- [x] **判断 31-a（基盤モデル）**: Muse Glimmer 30B と Gemma 4 を自前日本語評価とライセンスで比較選定（選定まで両対応の薄い推論層で実装）。
- [x] **判断 31-b（Jev の出力の学習利用）**: **使わない（確定）**。顧客データ・自社データともに学習禁止、提供元への許可依頼もしない。
- [x] **判断 31-c（本番推論用計算基盤）**: **承認済**（契約・鍵設定は下記 §3 へ）。
- [ ] **判断 31-d（テナント文の共通部品学習利用条件）**: 未決定（決定まで共通学習は自社サイト文のみ）。

### その他判断（手順進行に応じて決定・各機能は `not_entitled` ガード済み）
- [ ] **判断 7 (D-12R)** / **判断 9 (D-07R)** / **判断 10 (MCP書込危険度階級)** / **判断 11 (A-15R アフィリエイト枠パラメータ)** / **判断 13 (H-11 回答文保存・監査再開)** / **判断 15 (OEM料金・法務)** / **判断 16 (head/構造化データ/robots操作)** / **判断 17 (外部テナント個別最適化法務)** / **判断 18 (有償人間パネル1,300人)** / **判断 19 (外部学習計算基盤・委託先追加)** / **判断 20 (状態無し訪問の抽選既定)** / **判断 21 (定数初期値)** / **判断 22 (リリース月1周期・90日鍵ローテ・2人目の鍵担当者)** / **判断 23 (持ち寄り同意改定)** / **判断 24 (顧客側データ保存3段の法務確認)** / **判断 25〜28, 30**（各束の完了時に詳細追記）。

---

## 2. 本番への適用（DDL・デプロイ・旧システム停止）
- [ ] **旧 Inngest ジョブ停止**: `app.inngest.com` 上の旧 `heatmap-clickinsight` (`warm-heatmap-cache` 等) を Pause / Delete。
- [ ] **手順 0 本番記録スクリプト実行**: 波 0-C で作成される `scripts/link/inspect-prod-baseline.mjs` を本番環境から実行し、旧テーブルDDL・利用者一覧・旧データ全数調査を記録。
- [ ] **本番マイグレーション適用**: `migrations/link/` 配下の ClickHouse / Postgres DDL を本番へ適用（各波完了時に追記）。
- [ ] **Vercel / Cloudflare Workers デプロイ**: `feat/ugokilink-v2` レビュー完了後に本番デプロイおよび `git push`。

---

## 3. 鍵・設定・外部手続き
- [ ] **Search Console 一括書き出し有効化（取り戻せない時計）**: 自社5サイトすべてで GSC BigQuery / 一括書き出しを初日に有効化（過去にさかのぼれないため最優先）。
- [ ] **本番推論・学習用 GPU 計算基盤の契約と API キー設定**（判断 31-c 承認済み）。
- [ ] **オフライン署名鍵の発行と2人目の鍵担当者の指名**（判断 22）。
- [ ] **別オリジン枠（A3 サンドボックス）用の独立ドメイン登録**。
- [ ] **環境変数設定**: `env.example` に追加される新規環境変数（`CRON_SECRET` 等）を Vercel / Cloudflare Secrets へ投入。

---

## 4. 自社5サイトでの作業
- [ ] **サーバー・CDN生ログの保全設定**: 5媒体（`wakegai.jp`, `bihadashop.jp`, `bousuikouji.info`, `nvrseen.com`, `link-th.co.jp`）のアクセスログ・WP改訂履歴・アフィリエイト報告を消さずに残す設定。
- [ ] **新スニペット貼付・開示文面掲載**（手順 11 準備完了後）。

### 波 0-D / 波 1 追加タスク
- [ ] **[1-A 法務確認] プライバシー開示文面＆14日削除計画の法務提出**: `packages/contract/schema` の `generatePrivacyDisclosure()` / `generateDeletionPlan()` 出力を法務確認へ提出し、日本の法域行 (`JP`) 署名および `legalRecipientName`・R2 セグメント書換削除条項を確定する。
- [ ] **[0-D 本番配備] AI事業者IP・RFC 9421鍵スナップショット日次 Cron 設定**: `ActorEvidenceClock.captureAll()` を毎晩（波0: `nightly_wave0`）実行し追記専用 R2 へ保存＋鍵期限（7日以内、OpenAI鍵は 2026-11-25 期限見込）・20%超プレフィックス変動アラート接続。手順10までに `production_poll`（IP 8h / SAIL 20m / JWKS Cache-Control）へ切替。
- [ ] **[1-C / 1-D CI連携] Playwright 3エンジン実機検証 ＆ CRAWL 側 `urlkey/2` スイートハッシュ同期**: 220 固定ページフィクスチャの Chromium / WebKit / Firefox 実機一致検証および 360 URLキーベクトルのハッシュ照合を両リポジトリ CI に組み込む。

### 波 0-B / 0-C / 1-B 追加タスク
- [ ] **[0-C 実行コマンド] 本番記録スクリプトの実行**: `node scripts/link/inspect-prod-baseline.mjs --dry-run` で事前確認後、`CLICKHOUSE_URL=... CLICKHOUSE_RO_USERNAME=... CLICKHOUSE_RO_PASSWORD=... node scripts/link/inspect-prod-baseline.mjs --out baseline-prod-2026-11-20.json` を許可ネットワークから実行しオフライン保管。
- [ ] **[0-B ハードニング] `/api/experiments/pool` の cron 認証統一**: 他の `/api/cron/*` と同様に `lib/cron-auth.ts` 必須化および `middleware.ts` exact-match 化を検討。

### 波 0-A 追加タスク
- [ ] **[0-A 環境変数整理] 旧ダミー切替 env 削除**: Vercel 上に `HEATMAP_DUMMY_ONLY` / `CV_JOURNEY_DUMMY_ONLY` / `LINKSCRAWL_FORCE_FALLBACK` が残っていれば削除し、本番接続先（`CLICKHOUSE_*`, `LINKSCRAWL_API_URL`, `AIRECEIPT_*`, `GSC_SA_KEY_JSON`）を確認する。
- [ ] **[0-A DB確認] `clickinsight.ai_crawler_logs` の `tenant_id` 列確認**: 手順 0-C 本番 DDL 採取で `ai_crawler_logs` の存在および `tenant_id` 列有無を確認する。

### 波 2-C 追加タスク
- [ ] **[2-C インフラ配備] LINK 第 2 描画ワーカー（Playwright + CJK フォント）配備と 1 日描画能力実測**: `surf.capacity`（5 階級累積 ≥ 2x）と実ブラウザ 3 エンジン突合を実測。
- [ ] **[2-C CRAWL 切替] CRAWL 本線配備後に `createHttpCrawlContractClient` へ切替**: 固定ページで `surf.second_executor` / `surf.crawl_federation_ready` を確認。
- [ ] **[2-C オーナー確認] 検査環境向け robots.txt 許可または `robots_override` 承認登録**: 自社 5 サイトの初回変更前ベースラインスナップショットを取得。

### 波 2-D 追加タスク
- [ ] **[2-D 鍵儀式・判断 22] オフライン配布署名鍵（Ed25519）生成・2人目の鍵担当者指名・パスキー登録**: 公開鍵を `packages/sdk-snippet`・`workers/link-zone`・`packages/wp-plugin` に固定し、プライバシー緩和承認用パスキーを登録する。
- [ ] **[2-D 判断 2 確定] Stage B 計測タグ重量比較の `full` 群分割方式決定**: `all_verify_only`（約6週）か `half_verify_half_deliver`（推奨：約12週・1/6 PV並行配信可）を選択する。
- [ ] **[2-D 判断 3 / 4 配備] 自社5サイト Cloudflare ゾーンへの `workers/link-zone` 配備（`/_ugk/selftest` 確認）および WordPress サイトへの `ugokilink-companion.php` 設置・`ugk_owner_local_policy` 設定**。

### 波 2-A 追加タスク
- [ ] **[2-A 本番適用 G1–G4 / identity_plane] ClickHouse 2層分離 & 鍵レジストリ配備**:
  - 本番 ClickHouse にて CRAWL 用資格情報をローテーションし、`generateCrawlZeroGrantDdl()` で行動テーブル全権限剥奪を適用（`surf.G1`）。
  - 本番 ClickHouse に `generatePerTenantIdentityDdl()`（テナント別 RO ユーザー・`readonly=1 CONST`・PERMISSIVE+RESTRICTIVE 行ポリシー対）を適用し、5分見張り番の 30 日連続無事故ランインを開始（`surf.G2`, `store.G-9`）。
  - Postgres 鍵レジストリ配備および全オーナー/管理者の WebAuthn パスキー登録（`surf.identity_plane`, D-06）。
  - 自社 5 サイトに `_ugokilink.<host>` DNS TXT（TTL ≤300s）を設置し、ペアリング経路＋R5 パスキー承認で `LinkGrant` を有効化（`surf.link_grant_active`）。

### 波 2-B 追加タスク
- [ ] **[2-B 判断 5 / 専用 8 GiB ClickHouse 配備]**: 専用 8 GiB RAM ClickHouse LTS >= 26.3 ノードを確保し、`max_server_memory_usage = 7730941132`（7.2 GiB）・`users_without_row_policies_can_read_rows = 0` を設定。ロール `ugk_admin` / `ugk_loader` / `ugk_builder` / `ugk_eraser` / `ugk_ro_<tenant_id>` を作成。
- [ ] **[2-B 本番 DDL 適用]**: 手順 0-C 本番記録取得後、`migrations/link/README.md` に従い `migrations/link/001_clickhouse_v2.sql` および `migrations/link/002_postgres_v2.sql` を本番へ適用し、越境ゼロカナリア確認を実施。
- [ ] **[2-B 判断 14 / 判断 29]**: 本番バックアップ入替周期 ≤8 日・10 日目 `overdue` 削除アラート・R2/CH/PG 地域マッピング（既定 `jp`）と §5.12 段 2/3 提供条件を確定。
