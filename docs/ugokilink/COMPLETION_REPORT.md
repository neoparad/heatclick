# UGOKI LINK v2 完了報告（COMPLETION_REPORT）

- **作成日**: 2026-11-20
- **作業ブランチ**: `feat/ugokilink-v2`（起点: `claude/inngest-clickhouse-review-c87b69` `683203b`、未 push）
- **正本設計書**: `docs/proposals/2026-11-19-ugokilink-master-architecture-v2.md`
- **実装計画**: `docs/proposals/2026-11-20-ugokilink-implementation-plan.md` ＋ `docs/proposals/2026-11-20-ugokilink-implementation-plan-addendum-ml.md`
- **関連運用台帳**:
  - 変更・判断記録: `docs/ugokilink/BUILD_LOG.md`
  - オーナー作業一覧: `docs/ugokilink/OWNER_TODO.md`
  - 旧定期実行棚卸し: `docs/ugokilink/CRON_INVENTORY.md`
  - 本番切替・旧停止手順書: `docs/ugokilink/CUTOVER_RUNBOOK.md`
  - マイグレーション手順書: `migrations/link/README.md`

---

## 0. エグゼクティブサマリー

波 0 から波 7 までの **全 32 束**（追加分の `4-F`・`4-G`・`4-H`・`4-I`・`6-F` を含む）をローカルブランチ `feat/ugokilink-v2` 上に実装・単体検証・統合検証完了した。

- **絶対禁止事項（実装計画 §2）の完全遵守**:
  - 本番 DDL 適用・本番データ変更・Vercel/Cloudflare デプロイ・`git push` は一切未実行。
  - `.env*` ファイルの読み取り・改変・コミット 0 件（新規環境変数 34 件の名称と用途のみ `env.example` に追記）。
  - 未追跡作業資料 `docs/proposals/2026-11-19-ugokilink-v2-working/` は `.git/info/exclude` により保護・未コミット・実行時参照 0 件。
  - **Jev 出力の学習・重み・蒸留先生利用は一切実装せず、決定 31-b による永久禁止をコードと機械検査で固定**。
- **検証結果サマリー**:
  - **UGOKI LINK v2 全 Jest テスト**: **53 スイート / 958 テスト全 PASS（失敗 0・保留 0）**
  - **Node テスト**: `scripts/link/inspect-prod-baseline.test.mjs` **9/9 PASS**、既存 `workers/event-ingest` **101/101 PASS**
  - **型検査 (`npm run type-check`)**: **0 エラー（exit 0）**
  - **本番ビルド (`npm run build`)**: **成功（exit 0、静的 60 ページ ＋ 新規 `/api/v1/**` 13 ルートすべてビルド完了）**

---

## 1. 束ごとの状態（波 0〜波 7 全 32 束）

| 波 | 束 | 内容 | 状態 | 主な成果物パス | コミット | 試験結果 |
|---|---|---|---|---|---|---|
| **波 0** | **0-A** | 止血（本番ダミー29箇所全廃・テナント抜け7箇所＋SQLバインド4箇所修正・タグPIIサニタイズ） | **作り終えた** | `lib/llm/hybrid-query.ts`, `public/{v2/,}tracking.js`, `workers/event-ingest/`, `lib/heatmap/agent-heatmap-*.ts`, `tests/unit/wave0-no-dummy-and-tenant-guard.test.ts` | `6d9ef18`, `f5eee0b` | PASS（47 tests + 101 worker） |
| **波 0** | **0-B** | 定期実行棚卸し・旧 Inngest 登録 0 化 | **作り終えた** | `docs/ugokilink/CRON_INVENTORY.md`, `inngest.config.ts` | `1ef2e0e` | PASS |
| **波 0** | **0-C** | 本番 DDL・旧データ全数調査 読み取り専用スクリプト | **作り終えた** | `scripts/link/inspect-prod-baseline.mjs`, `scripts/link/inspect-prod-baseline.test.mjs` | `1ef2e0e` | PASS（9/9 Node） |
| **波 0** | **0-D** | 取り戻せない時計（24 公式ソース IP/SAIL/RFC 9421 鍵スナップショット保存） | **作り終えた** | `lib/link/clocks/actor-evidence-snapshot.ts` | `d9cceb8` | PASS |
| **波 1** | **1-A** | 単一正本契約スキーマ & 6 決定論的生成器 | **作り終えた** | `packages/contract/schema/**` | `584b5c9` | PASS（45 tests w/ 1-E） |
| **波 1** | **1-B** | 4 台帳（ゲート 236・定数 88・知りえないこと 21・判断 34［D-31b 永久ロック含］） | **作り終えた** | `packages/contract/ledgers/**` | `1ef2e0e` | PASS（19 tests） |
| **波 1** | **1-C** | 単一 URL キー関数 `urlkey/2`（360 適合ベクトル全通過） | **作り終えた** | `packages/contract/urlkey/**` | `d9cceb8` | PASS（360 vectors） |
| **波 1** | **1-D** | 外部依存ゼロ共通区切りプログラム（220 固定ページ HTML vs DOM 完全一致） | **作り終えた** | `packages/contract/segmenter/**` | `d9cceb8` | PASS（603 tests w/ 0-D, 1-C） |
| **波 1** | **1-E** | 共通返答形式・単一直列化器（8 状態・4 根拠・I1–I7・`VerifiedMetricValue`・`UntrustedValue`） | **作り終えた** | `packages/contract/response/**` | `584b5c9` | PASS |
| **波 2** | **2-A** | アカウント・4 種鍵・R0–R5・2 層分離（672 ケース越境 404）・LinkGrant・5 段階スケジューラ | **作り終えた** | `lib/link/auth/**`, `lib/link/isolation/**`, `lib/link/linkage/**`, `lib/link/scheduler/**` | `aab8808` | PASS（24/24） |
| **波 2** | **2-B** | 59 対 URL 分類・CH/PG DDL・R2 WAL・べき等ローダー（10 万通り＆168h 再現）・1h 確定集計・8GiB 枠・14 日削除・突き合わせ①–④ | **作り終えた** | `migrations/link/**`, `workers/link-wal/**`, `workers/link-loader/**`, `lib/link/store/**` | `b3fe7ac` | PASS（20/20） |
| **波 2** | **2-C** | LINK 第 2 描画環境・不変スナップショット＆系譜・CRAWL 契約代役・操作可能性監査 A | **作り終えた** | `lib/link/lab/**` | `4383934` | PASS（11/11） |
| **波 2** | **2-D** | オフライン Ed25519 署名サービス・≤2KB 固定スニペット・ゾーン Worker・WP プラグイン（`del.D20`）・主体盲目アロケータ | **作り終えた** | `workers/link-signer/**`, `packages/sdk-snippet/**`, `workers/link-zone/**`, `packages/wp-plugin/**`, `lib/link/allocator/**` | `b3d10f3` | PASS（30/30） |
| **波 3** | **3-A** | 新ブラウザ SDK（`tel.G7` 非干渉・5 同意モード・確定前非接触・リプレイ階層 0–2）＆受付 Worker（部分受理・Queue 後 ACK/R2 退避/503・急増遮断器） | **作り終えた** | `packages/sdk-browser/**`, `workers/link-collector/**` | `787664a` | PASS（11/11 w/ 3-B, 3-C） |
| **波 3** | **3-B** | Segment 6 種互換・顧客定義イベント・車線分離・5 分導入口 | **作り終えた** | `packages/sdk-browser/custom-events.ts`, `quickstart.ts`, `workers/link-collector/segment-compat.ts` | `787664a` | PASS |
| **波 3** | **3-C** | 統一検査印（6 目的）・アフィリエイト受け皿・6 パイプライン漏れ 0 ゲート | **作り終えた** | `packages/sdk-browser/lab-sink.ts`, `workers/link-collector/lab-marker.ts` | `787664a` | PASS |
| **波 3** | **3-D** | 行為者単一登録簿・RFC 9421/SAIL/FCrDNS/偽装 XFF・署名ログ 5 アダプタ・`Server-Timing` ±120s・Origin Kit 4 形式・E/T/P アドレス保護 | **作り終えた** | `lib/link/actors/**` | `b41646e` | PASS（20/20） |
| **波 3** | **3-E** | 直近 30 分 DO 集計（p95≤20ms）・無作為 3 分割並行稼働・11 種損失台帳・旧データ橋渡し・±5% 換算比判定 | **作り終えた** | `workers/link-live/**`, `lib/link/migration/**` | `c5cccb6` | PASS（10/10） |
| **波 4** | **4-A** | REST/MCP 読み取り面・OpenAPI 3.1・能力一覧・不変版セグメント/ファネル/経路・利用量・プライバシー・成果定義・社内 5 画面アダプタ | **作り終えた** | `lib/link/surface/**`, `app/api/v1/**`（10 ルート） | `45d84c7` | PASS（12/12 w/ 4-C） |
| **波 4** | **4-B** | 倉庫 5 種＋Parquet・ストリーム 4 種・3 区分 50 送り先＆隔離関数サンドボックス・§5.12 3 段・RO SQL 口・無人セルフサーブ＆料金計算 | **作り終えた** | `lib/link/export/**` | `c5cccb6` | PASS（10/10） |
| **波 4** | **4-C** | 8 言語サーバー SDK 自動生成＆共通適合試験・`POST /v1/ask`＆1,000 問事前登録評価束（数値誤り 0・拒否 100%・漏洩 0） | **作り終えた** | `packages/sdk-server/**`, `lib/link/ask/**` | `45d84c7` | PASS |
| **波 4** | **4-D** | 構造×行動照合キー突合・`M_sec`/`O`/`G`・部分持ち寄り・アフィリエイト 5 段階＆`join.G13`・物販 EC 3 受け口/鮮度/粗利分離/会員停止印 | **作り終えた** | `lib/link/join/**`, `lib/link/revenue/**` | `e83ef9e` | PASS（17/17） |
| **波 4** | **4-E** | GSC＆GA4（`page×day` 限定）・クエリ→区画＆Fréchet/Manski 上下限・日本語公開埋め込み選定・AI 検索探針＆適格性無作為化 | **作り終えた** | `lib/link/search/**` | `e83ef9e` | PASS（7/7） |
| **波 4** | **4-F** | ML 基盤（正解/特徴契約・点時点漏れ遮断・決定引換券・登録簿＆削除伝播・Inngest GPU 契約・§8.8 昇格/巻戻し・≤50KB int8 木評価器） | **作り終えた** | `lib/link/ml/foundation/**` | `cd77c97` | PASS（4/4） |
| **波 4** | **4-G** | 生成モデル薄い層（Muse Glimmer 30B / Gemma 4 両対応）・30B VRAM 試算・Jev 公開文専用クライアント（閉鎖）・自前数字検証器・仮説台帳・運転役 | **作り終えた** | `lib/link/ml/llm/**` | `cd77c97` | PASS（4/4） |
| **波 4** | **4-H** | 追加学習経路 §8.14（盲検 2 名採点・出どころ機械検査［Jev 0 件］・3 分割重複 0・仕事別 LoRA 評価/守り試験・24h 除外/14 日削除・自前先生蒸留） | **作り終えた** | `lib/link/ml/finetune/**` | `cd77c97` | PASS（5/5） |
| **波 4** | **4-I** | ヒートマップ画像返却 REST & MCP（§11.12 全 6 ゲート・行為者 5 区分・版/案一致重ね vs 模式図・純 TS 決定論 PNG・差分攻撃防御） | **作り終えた** | `lib/link/heatmap-render/**`, `app/api/v1/sites/[siteId]/heatmap-image/route.ts` | `fd98210` | PASS（8/8） |
| **波 5** | **5-A** | 影配信 A0・封印発火・決定完全性 (`ev.G-3`)・SDK 重さ 3 万 PV TOST (`tel.G16`) | **作り終えた** | `lib/link/delivery/shadow-weight.ts` | `9155a25` | PASS（16/16 w/ 5-B, 5-C） |
| **波 5** | **5-B** | 統一 AST 発火言語・A0–A3 表現＆閉じた文法ランタイム（2.55 KB gzip）・K1–K4 停止 1,500 回訓練・事前検査・KV 禁止エッジ判断 Worker・`POST /v1/decisions`・機能フラグ 2 評価 | **作り終えた** | `lib/link/delivery/**`, `packages/sdk-runtime/**`, `workers/link-decision/**`, `app/api/v1/decisions/route.ts` | `9155a25` | PASS |
| **波 5** | **5-C** | 最初の無作為試験・α 分割・CUPED・`ev.G-6` 1,000 回プラセボ・5 経路 `proven` 判定・D-07R・勝利後ライフサイクル | **作り終えた** | `lib/link/evidence/**` | `9155a25` | PASS |
| **波 6** | **6-A** | LP 期待超過離脱検出（Gamma-Poisson＋BH FDR≤10%）・提案 5 源・学習セグメント（重心/密度・ID 引継ぎ・4-A 接続）・集計/階層 1–2 長期統計 | **作り終えた** | `lib/link/models/detection/**`, `lib/link/models/segments/**` | `6c090e7` | PASS（20/20 w/ 6-F, 6-D） |
| **波 6** | **6-B** | ブラウザ内ローカル AI 尤度比＆誤検知上限証明書・非混合 4 計器・AI 検索 8 段階統合台帳 | **作り終えた** | `lib/link/ai-layer/**` | `5e946a4` | PASS（5/5） |
| **波 6** | **6-C** | 変更効果台帳（`observed` 上限）・前向きメタ分析・元サーバーアダプタ＆生成器・ページ単位無作為展開・1 万回再生自動配分検定 | **作り終えた** | `lib/link/rollout/**` | `e3db821` | PASS（6/6） |
| **波 6** | **6-D** | 推薦最下段〜二塔/系列 NN・円換算価値・物販 EC 完全推薦（全集合 Plackett-Luce 確率保全・合わせ買い・再購入・ログイン会員合流）・アシスタント 3 段・`POST /v1/recommend` | **作り終えた** | `lib/link/models/recommend/**`, `lib/link/models/assistant/**`, `app/api/v1/recommend/route.ts` | `6c090e7` | PASS |
| **波 6** | **6-E** | パスキー封入自律枠・項目ベースエージェント公開＆1,040 件乗っ取り試験・4 ビット取り置き主張（180 日失効）・クロステナント持ち寄り＆連合学習 | **作り終えた** | `lib/link/autonomy/**` | `e3db821` | PASS（5/5） |
| **波 6** | **6-F** | ポップアップ「いつ」3 段（ルール→int8 木→int8 小 NN）＆タイミング無作為化・「出すか/どれを」5 段＆統一バンディット定数 | **作り終えた** | `lib/link/models/popup/**` | `6c090e7` | PASS |
| **波 7** | **7-A** | 外部テナント受入ゲート・OEM 管理（CRAWL 非共有）・全車線課金守り（100 万件洪水 0 変動・30 日台帳突合） | **作り終えた** | `lib/link/oem/**` | `6cbd620` | PASS（4/4） |
| **波 7** | **7-B** | 画面付き再生・リプレイ階層 3（送信前全マスク・土台 5 組照合・R2 専用・空 `sandbox` 隔離枠・復号展開後カナリア漏れ 0） | **作り終えた** | `lib/link/replay/**` | `15ee9d8` | PASS（4/4） |
| **波 7** | **7-C** | モバイル 4 環境 SDK（iOS Swift / Android Kotlin / React Native TS / Flutter Dart・撤回ゼロ送信消去・独自描画枠マスク） | **作り終えた** | `packages/sdk-mobile/**` | `15ee9d8` | PASS（4/4） |
| **波 7** | **7-D** | 11 保存役割の地域所在監査器・OSS 公開境界漏れ監査＆段 3 セルフホスト能力表 | **作り終えた** | `lib/link/residency/**` | `6cbd620` | PASS（3/3） |
| **波 7** | **7-E** | 30 日直接 R2 影書込検証・1000 倍キュー分割・レプリカ 3 条件・旧 9 資産停止状態機械＆手順書 | **作り終えた** | `lib/link/cutover/**`, `docs/ugokilink/CUTOVER_RUNBOOK.md` | `6cbd620` | PASS（5/5） |
| **波 7** | **7-F** | `env.example` 34 変数追加・`jest.config.js` worktree 除外・横断 E2E ＆ゼロ保留監査・既存クライアントバンドル `node:*` 分離修正・全試験/`type-check`/`build`・完了報告 | **作り終えた** | `env.example`, `jest.config.js`, `tests/unit/ugokilink-v2-integration.test.ts`, `lib/heatmap/agent-heatmap-server.ts`, `lib/ml/pragmatic-ml-server.ts`, `lib/ml/semantic-internal-links.ts`, `docs/ugokilink/COMPLETION_REPORT.md` | 最終コミット | PASS（53/53 suites, 958/958 tests, `build` 0） |

> **注（LINKTH CRAWL 側 — 実装計画 §6）**: 設計書 §15 の 15 群は別リポジトリ（LINKTH CRAWL 本線）の作業であるため本リポジトリには含めず、LINK 側は契約準拠スタブ（`lib/link/lab/crawl-client.ts`）および LINK 第 2 描画環境（`2-C`）により独立検証済み。

---

## 2. ゲートごとの状態一覧

### 2.1 コード / CI 契約検証が開いている（PASS 済み）主要ゲート

| ゲート群 | 検証内容 | 結果 |
|---|---|---|
| 契約・台帳 (`1-A`–`1-E`) | 6 生成器決定論一致、未分類パラメータ形状非漏洩、360 URL キーベクトル、220 固定ページ HTML=DOM 一致、I1–I7 単一直列化、`tel.M9` 全 19 操作違反 0 | **CI PASS** |
| 分離・認証 (`surf.G1`–`G4`, `surf.identity_plane`, `store.G-7`) | SQL AST 検査＋クオートファジング、PERMISSIVE+RESTRICTIVE 行ポリシー対 DDL、672 ケース他テナント 404 マトリクス 0 漏洩、4 種鍵・R0–R5・5 分見張り番 | **CI PASS** |
| 保存・耐障害 (`tel.G1`, `store.G-1/2/4/5/6/8/10`) | 10 万通りドロップ/重複/順序入替 100% 一致・2 重配置 0、1 週間（168h）R2 WAL 完全再構築、8 GiB 予算（5.74≤6.12 GiB）、14 日削除計画、独立突き合わせ①–④ | **CI PASS** |
| 信頼連鎖・計測 (`del.D1`, `del.D3`, `del.D12`, `del.D20`, `tel.G7/G10`) | 赤チーム攻撃ゲート 1/2、入力文字非干渉（`Buffer.compare===0`）、同意前ストレージ非接触 0 回、統一検査印 6 パイプライン漏れ 0、K1–K4 1,500 回訓練 0 違反、壊れたパッチ 60 件 0 見逃し、WP 59 回同時編集 0 損失、`sdk-runtime` 2.55 KB gzip ≤ 14 KB | **CI PASS** |
| 行為者・突合・ヒートマップ (`act.G1–G7/G31`, `join.G4/G13`, `§11.12`) | RFC 9421 Ed25519/ECDSA、SAIL 3 連続ミス否定、偽装 XFF 頭打ち、Class E 30 日鍵破棄復号不能化、`join.G13` 対応差 95% CI、§11.12 全 6 ゲート（決定論 PNG・取得毎認証・差分攻撃 403・削除後 410・プロンプト注入隔離） | **CI PASS** |
| ML・実験・自律・再生 (`ev.G-6`, `surf.ask_accuracy`, `surf.replay_zero_leak`, `§10.10`) | `ev.G-6` 1,000 回プラセボ検定通過、`POST /v1/ask` 1,000 問評価（数値誤り 0・正拒否 100%・漏洩 0）、8 言語 SDK 0 食い違い（Node/Python ライブ実行）、復号展開後カナリア漏れ 0/10＆0/9、エージェント 1,040 件乗っ取り試験枠外 0 件、EC 全集合 Plackett-Luce 6,000 回検証（7/18 バイアス排除）、100 万件公開キー洪水請求変動 0 | **CI PASS** |

### 2.2 意図的に閉じたままにしているゲート（何で開くか）

実装計画 §4 および追加計画 §5 に従い、コードは完備した上で既定 `not_entitled` / `challenger` / `closed` として安全閉鎖している。

| ゲート / 機能 | 現状 | 開放条件（オーナー作業・実データ・法務） |
|---|---|---|
| **D-31b: Jev 出力の学習・重み・蒸留先生利用** | **永久禁止 (`prohibited_by_decision`)** | **開かない**（2026-11-20 オーナー確定＆提供元規約 2.3(b) により恒久閉鎖） |
| **Jev 公開ページ文の実通信呼出 (`4-G`)** | `CLOSED (not_entitled)` | 法人契約（保存期間/ゼロ保持・削除条件）＋米国処理地域ゲート承認＋日本語人ラベル ≥300 件評価 |
| **Jev 不一致による人回し選別 (`4-H`)** | `CLOSED (not_entitled)` | 規約 2.3(b) 法務確認記録（それまで自前生成モデルの不確実性＋無作為抜き取りのみ） |
| **外部テナント文の共通 LoRA 学習 (`D-31d`, `4-H`)** | `CLOSED (not_entitled)` | オーナー判断 31-d＋法務署名＋明示オプトイン（決定まで自社サイト文のみ） |
| **追加部品（LoRA）・蒸留分類器・仮説部品の昇格 (`4-H`)** | `CLOSED (challenger のみ)` | 仕事別 `final_eval` ≥300 人ラベル（2 名盲検 κ≥0.70）＋§8.8 影 14 日＋守り試験 0 失敗；仮説部品は独立無作為実験数の充足 |
| **基盤モデル最終選定 (`D-31a`, `4-G`)** | `選定待ち（両対応済）` | Muse Glimmer 30B（Apache 2.0）と Gemma 4 のライセンス本文法務確認＋実 GPU 日本語評価 |
| **本番 30B 推論・学習 GPU 基盤 (`D-31c`, `D-19`)** | 契約承認済・配備待ち | クラウド GPU 契約・API キー設定・実測 VRAM/p95/原価計測 |
| **Wave 6 全 ML 上位段 (`6-A/D/F`)** | `CLOSED (challenger 登録)` | 実測データ蓄積＋§8.8 オフライン/影 14 日/全単位再生通過（ポップアップバンディットは案あたり見込み ≥310 CV・最少案確定 ≥50 CV） |
| **同意モード JP 告知＋オプトアウト (`D-01`)** | `cookieless` 既定 | 日本外部送信規律の法務確認・署名＆開示掲載検証通過 |
| **リプレイ階層 1–2 (`D-08`)・画面付き再生階層 3 (`D-26`, `7-B`)・文の預かり (`join.G18`)** | `CLOSED (not_entitled)` | オーナー決定 D-08 / D-26 ＋法務署名＋Playwright 3 エンジン実機ゼロリーク検証 |
| **サーバー IP E/T/P 類保持 (`D-12`, `act.G32`)** | `CLOSED (not_entitled)` | D-12（30 日封印）および Class P（72 時間）の別法務署名＋本番 KMS 鍵破棄接続 |
| **アフィリエイト枠パラメータ (`D-11`)・AI 検索生回答文 (`D-13`)・head/robots (`D-16`)** | `CLOSED (not_entitled)` | 各判断承認・法務署名・オフライン署名許可表リリース・パスキー承認 |
| **外部テナント・OEM・外部送り先(ii)/(iii)・OSS 公開・顧客正本段 3 (`D-15/17/23/24/27/28/29/30`)** | `CLOSED (not_entitled)` | 各判断＋法務署名＋見張り 2 テナント 30 日連続 0 漏洩＋30 日課金台帳突合＋11 保存役割 JP 契約固定確認 |
| **実データ蓄積ゲート (`tel.G16`, `tel.G18`, `store.G-14`, `store.G-20`, `ev.G-5`, `D-07R`, `assistant.tier3`, `D-18`)** | `CLOSED (計測器実装済)` | 並行稼働 ±5%、SDK 重さ各群 3 万 PV、直接 R2 影 30 日、旧停止 30 日無事故、有償人間パネル 1,300 人、D-07R 30 介入/3 サイト、アシスタント 200 質問忠実度 |

---

## 3. 束 4-F・4-G・4-H・6-F 詳細報告（追加計画 §6 必須項目）

### 3.1 各束の状態と閉鎖ゲート
- **4-F（ML 基盤 — `lib/link/ml/foundation/`）**: 実装完了・4/4 PASS。点時点漏れ防止・引換券・登録簿・8日/14日削除伝播・Inngest GPU 契約（CRAWL VPS / ClickHouse 投入物理遮断）・§8.8 2 入口昇格・≤50KB int8 木評価器（200 ベクトル browser===server ビット一致）完備。本番 GPU 契約・実データ昇格待ち。
- **4-G（生成モデル＆Jev — `lib/link/ml/llm/`）**: 実装完了・4/4 PASS。Muse Glimmer 30B / Gemma 4 薄いサーバー専用層・Jev 公開ページ文専用クライアント（既定閉鎖）・Jev 不使用の自前数字検証器・仮説台帳・週次運転役完備。モデル選定（D-31a）・GPU 配備（D-31c）・Jev 契約/地域/日本語 300 件評価待ち。
- **4-H（追加学習経路 §8.14 — `lib/link/ml/finetune/`）**: 実装完了・5/5 PASS。2 名独立盲検採点・Cohen κ・出どころ機械検査・Union-Find 境界固定 3 分割・仕事別 LoRA パイプライン（読み取り用/仮説用分離、守り試験 1 件失敗即拒否、仮説昇格閉鎖）・24 時間除外/14 日削除証明・自前先生限定 ≤50KB int8 蒸留完備。実人ラベル ≥300 件・独立実験数・D-31d 判断待ち。
- **6-F（ポップアップモデル §8.3 — `lib/link/models/popup/`）**: 実装完了・PASS。「いつ」3 段（ルール `S0` → int8 離脱予兆木 `S1` → int8 並び小 NN `S2`、各 ≤50KB）＆反事実タイミング無作為化（`no_show` 対照の初回閾値超過時刻記録・共通下位閾値集合比較）、「出すか/どれを」5 段（`P0`〜`P3` CATE、4-G 案属性事前分布、統一バンディット定数 `max(0.10, 1/(2K))` / 均等 10% / 開始 310 CV / 更新 50 確定 CV / 7 日確認 / 1 万回 IPS 再生）完備。上位段は `challenger` 登録のまま実データ蓄積待ち。

### 3.2 学習データの出どころ機械検査の結果
`lib/link/ml/finetune/dataset-builder.ts` (`verifyTrainingDatasetProvenance`)・`deletion-distill.ts` (`distillInHouseModelToInt8Classifier`)・`tests/unit/ugokilink-v2-integration.test.ts` にて機械検証済み:

| 検査項目 | 検証結果 | 強制機構 |
|---|---|---|
| **Jev の出力（学習データ・重み・蒸留先生）** | **0 件** | D-31b 永久ロック (`prohibited_by_decision`)、`JevTrainingProhibitedError` / `JevTeacherProhibitedError` で即時例外 |
| **訪問者 1 人ずつの行** | **0 件** | 推論時 `VisitorRowProhibitedError` ＋学習出どころ検査の二重遮断 |
| **許可の無い外部テナントの文** | **0 件** | D-31d 未決の間、`shared_adapter` は自社サイト文のみ許可 |
| **非標準車線（`custom_event` / `screen_replay`）由来** | **0 件** | 標準計測 (`standard_telemetry`)・公開ページ文以外を即拒否 |
| **3 分割（`train` / `select_tune` / `final_eval`）重複** | **0 件** | `overlapping_page_lineages = 0`, `overlapping_near_dup_clusters = 0`, `overlapping_experiment_ids = 0` |

### 3.3 30B 生成モデル推論メモリ試算と手元未確認事項
`lib/link/ml/llm/provider.ts` (`estimateGenerativeInferenceResources`: `muse-glimmer-30b` 想定、64 層・8 KV head・head_dim 128・hidden 5120・入力 4,096 tok・出力 512 tok・同時実行 4・同時常駐 LoRA 3 本 rank 16・活性化余白 18%):

| 量子化 | 重み VRAM | KV キャッシュ | LoRA 3 本 | 活性化余白 | **合計必要 VRAM** | 推奨 GPU 構成 |
|---|---:|---:|---:|---:|---:|---|
| **BF16** | 55.88 GiB | 4.50 GiB | 0.41 GiB | 10.94 GiB | **71.73 GiB** | `1× H100 80GB` または `1× A100 80GB` |
| **FP8** | 29.34 GiB | 4.50 GiB | 0.41 GiB | 6.16 GiB | **40.41 GiB** | `1× L40S 48GB` または `1× A6000 48GB` |
| **INT4 (AWQ)** | 16.20 GiB | 4.50 GiB | 0.41 GiB | 3.80 GiB | **24.92 GiB** | `1× L40S 48GB`（最小 48GB 推奨） |

- **手元で確かめられなかったこと**: 実 GPU 上での Muse Glimmer 30B / Gemma 4 実重みロード時の実測 VRAM・p95 レイテンシ・1,000 件あたり推論原価・日本語精度実測値、両モデルの公式 LICENSE 本文ファイルの法務精読、および実人間 2 名盲検採点 ≥300 件による初回 LoRA 昇格。

---

## 4. 設計書と変えたところ・実装判断の要約（`BUILD_LOG.md` 要約）

設計書本体の書き換えは一切行わず、食い違い・具体化判断はすべて `docs/ugokilink/BUILD_LOG.md` に記録した。主な要点:
1. **未分類 URL パラメータ（1-A / 1-C）**: 作業資料と設計書 §6.4 の優先裁定として設計書正本を採り、形状情報（数値判定等）を出さず長さ区分トークンのみ＋`key_degraded = true` で実装。
2. **Workers 型定義の非汚染（2-B / 2-D / 3-A / 3-E / 5-B）**: ルート `tsconfig.json` (`strict: true`, `noUnusedLocals`, `noUnusedParameters`) との整合のため、Cloudflare Workers は外部グローバル型に依存せず最小ローカルインターフェース（`R2BucketLike`, `QueueLike`, `DurableObjectStateLike` 等）で型安全に実装。
3. **既存クライアントバンドル `node:*` 混入の分離（7-F）**: 起点コミット `683203b` 時点で `components/heatmap/*`・`components/scenarios/*`・`app/(proof)/seo/{access,internal-links}/page.tsx` が間接的に `node:os` / `node:crypto` を引き込み `npm run build` が失敗していたため、サーバー専用関数を `lib/heatmap/agent-heatmap-server.ts`・`lib/ml/pragmatic-ml-server.ts` へ分離、ブラウザ向け純計算を `lib/ml/semantic-internal-links.ts`・`lib/seo/filter.ts` へ整理し、既存挙動を一切壊さず `npm run build` を完全成功させた。
4. **社内 5 画面の付け替え方式（4-A）**: 既存の稼働画面を壊さない原則（§2）に従い、`lib/link/surface/internal-screens-adapter.ts` にフィーチャーフラグ切替式 `/v1` アダプタを実装（本番 `/v1` Repository 接続後にフラグ切替）。
5. **ヒートマップ決定論的 PNG 生成（4-I）**: OS/ネイティブフォント・Canvas 依存による環境差を排除するため、Node 標準 `zlib.deflateSync`＋CRC32 による純 TypeScript RGBA8 PNG エンコーダを実装し、固定入力での SHA-256 バイト完全一致を保証。

---

## 5. 試験・ビルド結果一覧

| 検証種別 | コマンド | 結果 | 備考 |
|---|---|---|---|
| **UGOKI LINK v2 全 Jest** | `npx jest packages/contract packages/sdk-* packages/wp-plugin workers/link-* lib/link tests/unit/wave0-no-dummy-and-tenant-guard.test.ts tests/unit/ugokilink-v2-integration.test.ts` | **53/53 スイート・958/958 テスト PASS** | 失敗 0・**保留 0**（36.3 秒） |
| **既存連携回帰 Jest** | `npx jest --runTestsByPath lib/ml/pragmatic-ml-engine.test.ts lib/heatmap/agent-heatmap-client.test.ts` | **2/2 スイート・10/10 テスト PASS** | 分離リファクタ後回帰 0 |
| **0-C 本番記録 Node 試験** | `node --test scripts/link/inspect-prod-baseline.test.mjs` | **9/9 PASS** | `.env*` 非参照・SELECT/SHOW 限定確認 |
| **既存 Worker 回帰試験** | `npm test --prefix workers/event-ingest` | **101/101 PASS** | 既存稼働 Worker 無破壊確認 |
| **TypeScript 型検査** | `npm run type-check` (`tsc --noEmit`) | **0 エラー（exit 0）** | リポジトリ全体 `strict: true` 通過 |
| **Next.js 本番ビルド** | `npm run build` (`next build`) | **成功（exit 0）** | 60 静的ページ＋新規 `/api/v1/**` 13 ルート全生成 |
| **保留テスト・禁止事項監査** | `tests/unit/ugokilink-v2-integration.test.ts` | **5/5 PASS** | 50 テストファイルで保留 0、261 本番ファイルで `.env` 読取 0・working 参照 0、13 `/api/v1` ルートでダミー 0 |

### 手元で確かめられなかったもの（実機・本番環境待ち）
1. 本番 ClickHouse 8 GiB ノード・Postgres RLS・Cloudflare Workers/R2/Queues/Durable Objects 実配備下での負荷・遅延・30 日連続稼働・復旧時間（RTO）。
2. Playwright 実ブラウザ 3 エンジン（Chromium / WebKit / Firefox）＋iOS 実機（LINE / Yahoo! JAPAN / Google アプリ内ブラウザ含む）での `tel.G3` / `tel.G7` / `surf.replay_zero_leak` / 220 ページ実機一致。
3. 8 言語サーバー SDK のうち本機にランタイム未導入の 6 言語（Go / Java / Ruby / PHP / .NET / Rust）のライブサブプロセス実行（TypeScript/Node.js と純 Python RFC 8032 Ed25519 はライブ実行で 0 食い違い確認済、残り 6 言語は静的契約検証 PASS）。
4. モバイル 4 環境（iOS / Android / React Native / Flutter）実機・エミュレータでの起動重量・電池・オフライン通信検証。
5. 実 GPU 上の Muse Glimmer 30B / Gemma 4 推論および日本語公開埋め込み実モデル比較。
6. 有償同意人間パネル 1,300 人（`D-18`）・自社 5 サイト実トラフィックでの並行稼働 ±5% / SDK 重さ 3 万 PV / 実験データ蓄積。
7. 既存の旧レガシーテストの一部（`tests/unit/sidebar-nav-ssot.test.mjs`、`__tests__/utils.test.ts` 等、起点 `683203b` 以前から旧 UI/未設定 env に依存して失敗している既存テスト群）。

---

## 6. 既知の弱点と、次に直すべき順（優先順位付きアクション）

詳細は `docs/ugokilink/OWNER_TODO.md` および `docs/ugokilink/CUTOVER_RUNBOOK.md` を参照。

1. **【最優先・今日中】旧外部 Inngest アプリ `heatmap-clickinsight` (`I-5`) の停止 & 取り戻せない時計の開始**:
   - `app.inngest.com` 上の `I-5` を即座に Pause/Delete（ClickHouse OOM リスクの即時除去）。
   - 自社 5 サイトで **Search Console 一括書き出し** を初日有効化し、`ActorEvidenceClock`（0-D）の日次 R2 スナップショットとサーバー/CDN 生ログ保全を開始。
2. **【第 2 優先】手順 0-C 本番記録の採取 & 期限付きオーナー判断の確定**:
   - 許可ネットワークから `scripts/link/inspect-prod-baseline.mjs` を実行して本番 DDL・旧データ全数調査をオフライン保管。
   - 期限付き判断（**判断 1** 同意・**判断 2** 比較群・**判断 3/4** ゾーン Worker/WP プラグイン・**判断 5** 8 GiB ClickHouse・**判断 8(b)** 30 日以内・**判断 12/14/29**）を確定し、オフライン Ed25519 署名鍵儀式（判断 22）と WebAuthn パスキー登録を実施。
3. **【第 3 優先】本番インフラ配備・Repository 結線・2 層分離適用**:
   - 専用 8 GiB ClickHouse へ `migrations/link/001_clickhouse_v2.sql`・Postgres へ `002_postgres_v2.sql` を適用し、CRAWL 行動テーブル全権限剥奪（`surf.G1`）とテナント別 RO ユーザー＆5 分見張り番（`surf.G2`, `store.G-9`）を開始。
   - `app/api/v1/**`（`surface`, `decisions`, `recommend`, `heatmap-image`）のランタイムコンテキストへ本番 ClickHouse / Postgres / Durable Objects / R2 ストアを結線（現在は未接続時 `not_collected` フェイルクローズ状態）。
   - 既存 `/api/experiments/pool` の cron 認証を `lib/cron-auth.ts` に統一（0-B 監査所見）。
4. **【第 4 優先】自社 5 サイト並行稼働（手順 11）→ 直接 R2 影書込 → 旧システム停止**:
   - `docs/ugokilink/CUTOVER_RUNBOOK.md` に沿い、`tel.G18` ±5% 収束 → 社内 5 画面 `/v1` 切替 → 旧データ橋渡し（厳密順序）→ 30 日直接 R2 影一致（`store.G-14`）→ 30 日無事故（`store.G-20`）の後に旧資産を段階停止。
5. **【第 5 優先】実機 CI 整備 & GPU/モデル選定・人ラベル蓄積**:
   - CI コンテナで Go/Java/Ruby/PHP/.NET/Rust 6 言語 SDK ライブ適合試験・Playwright 3 エンジン実機試験・モバイル 4 OS 実機試験を常設化。
   - GPU 契約（D-31c）→ Muse Glimmer 30B vs Gemma 4 ライセンス確認＆実機評価（D-31a）→ `POST /v1/ask` 1,000 問実モデル再評価 → 2 名盲検人ラベル ≥300 件蓄積。
6. **【第 6 優先】LINKTH CRAWL 本線側（設計書 §15 1〜15 群）の実装**:
   - LINKTH CRAWL の本線チェックアウトにて §15 の 15 群を実装し、LINK 側 `lib/link/lab` の契約スタブを `createHttpCrawlContractClient` へ切替。
7. **【第 7 優先】外部テナント・OEM・OSS 公開・画面付き再生の段階開放**:
   - 見張り 2 テナント 30 日連続 0 漏洩・レプリカ条件③・30 日課金台帳突合・各法務署名（D-15/17/23/24/26/28/29/30）を満たした項目から順にゲートを開放。
