# UGOKIMAP AI Chat — 分析能力最大化 設計書 (2026-06-06)

`docs/ai-chat-analytics-design.md`(2026-06-04) の続編。freeform AI チャットの分析天井を引き上げる。
Owner 承認済み + Codex 議論済み + 本番 ClickHouse 実測で接地。

3カテゴリ構成:
- **A. 単発ツール拡張** — 「聞けるのに聞けない」を潰す (Phase 1、本書時点で実装済)。
- **B. Deep Research モード** — 時間をかけた多段調査 (設計確定、実装は別途)。
- **C. ML/統計** — 統計は今、ML は前提充足後 (方針確定)。

---

## 0. 設計原則の転換 (重要)

旧: 「bihadashop で取れているデータ」を基準にツールを作る。
新: **「スキーマが対応していれば作る。データが無いサイトでは正直に"未計測"と言う」**
   (各ツールにデータ準備チェックを内蔵 = `analytics_data_readiness`)。

理由: SaaS は複数サイトを抱える。Codex が「罠」と呼んだ CV/経路/リテンション等は、bihadashop が
1ページLPで取れていないだけで、フリートにはデータが実在する (下記実測)。

### フリート実測 (本番90日・is_agent=0・集計のみ・PIIなし、2026-06-06)
| サイト | sessions | CV計測 | 平均PV/session | 複数ページ |
|---|---|---|---|---|
| CIP_EcwUTHEZdIOAUqum | 28,374 | 98件/74セッション ✅ | 1.47 | 少 |
| CIP_QWaPiks5krukJ6NM (linkth_internal/wakegai) | 18,655 | 0 | 7.38 ✅ | 1,143 ✅ |
| CIP_8eN7xgfBtDAnzE26 | 5,492 | 0 | 3.54 | 200 |
| CIP_6r2WofQDSKrOwxmM | 851 | 0 | 3.88 | 50 |

fleet 実在: CV(conversion_type)、複数ページ経路、form_view 5,315、video_events、image_visibility。
**真の未計装 = `conversion_value`(売上"金額") 全サイト0** → CVの有無は取れるが金額は不可。

### スキーマ実測で判明した未投入列 (ツール設計に反映済)
- `element_visibility_v2`: `is_above_fold` / `is_cta` / `element_clicked` / `max_visible_ratio` が **全0** (tracker 未投入)。
  → above-fold は `element_y <= viewport_height` で導出、滞在は `visible_duration_ms` の **median** で測る (平均は外れ値で歪む)。
- `video_events`: `video_milestone` / `video_played_ms` / `video_completed` 列がほぼ未投入。
  → エンゲージは `event_type` 件数 (video_play / video_milestone / video_pause / video_complete) で測る。
- `gsc_data`: `tenant_id` 列なし (site_id のみ) かつ空。

---

## A. 単発ツール拡張 (Phase 1 — 実装済 2026-06-06)

既存17ツールと重複しない穴だけを埋める6ツールを追加 (計23)。全て standalone (parentQueryId 不要)、
全SQLを本番で検証済。tenant_id/site_id は server 固定、is_agent=0、Code-386 日付 fix、query_params バインド。

| ツール | 何が分かる | 主データ | evidence | 点灯条件 |
|---|---|---|---|---|
| `analytics_data_readiness` | このサイトで何が分かるか在庫 (capabilities / blocked) | events + 各専用テーブル | observed_exact | 常時 (D-07防波堤・DR scoping の頭脳) |
| `analytics_time_to_interaction` | 初回操作までの秒数(TTFI)・interaction_rate | events (pageview→click系) | observed_approx | pageview 有 |
| `analytics_dead_zones` | 座標ビン別 dead/rage 密度 (押せない箇所) | events click_x/y | observed_approx | click系 有 |
| `analytics_retention` | 再訪率・訪問回数分布 | events visitor_id | observed_approx | 再訪 有 |
| `analytics_media_engagement` | 動画/画像のエンゲージ | video_events + image_visibility | observed_approx | メディア 有 |
| `analytics_above_fold` | FV要素の露出 vs 滞在 (素通り候補) | element_visibility_v2 (element_y 導出) | observed_approx | element_visibility 有 |
| `analytics_crosstab` (1b) | 指標×2軸ピボット (例: デバイス×参照元のCVR) | events (metrics 軸再利用) | observed_approx | 常時 |
| `analytics_journeys` (1b) | 多段ジャーニー全経路 (A>B>C…) | events pageview (timestamp 連結) | observed_approx | 複数ページ 有 |
| `analytics_segment_compare` (1b) | 2セグメント比率の有意差 (z検定) | events (cvr/bounce_rate) | observed_approx | 常時 |

**CVR計測バグ修正 (1b)**: `buildMetricExpr`/`buildDimensionExpr` が `event_type='conversion'`(本番に存在せず全0) を見ていた →
`conversion_type` 列ベースに修正。これで metrics/crosstab/segment_compare の cvr/conversions が、CV設定済サイトで正しく点灯する
(売上 revenue は `conversion_value>0` ベース、金額未計装サイトは0)。

### 実装パターン (レジストリ駆動)
- `lib/llm/hybrid-query.ts`: `execute*Query()` を追加 (テンプレ = `executeTopPagesQuery`)。
- `lib/llm/analytics-tools.ts`: Zod schema / `AnalyticsToolName`+`AnalyticsToolResult` union / `ANALYTICS_TOOL_SCHEMAS` / dispatcher case。
- `lib/llm/orchestrator.ts`: system prompt のツール一覧に1行ずつ + `FREEFORM_MAX_STEPS` 6→8。
- `lib/llm/freeform-tools.ts`: 変更不要 (registry 自動 wrap、dot→underscore)。
- 回帰テスト `lib/llm/freeform-tools.test.ts`: tool 名が Anthropic 制約 `^[a-zA-Z0-9_-]{1,128}$` を満たすこと (続120 の400再発防止)。

### 既存ツールで回答可 (新規不要)
- CV率/CVファネル = `analytics_metrics`(cvr/conversions) + `analytics_funnel`(windowFunnel) + contributors/drilldown。
- 経路 = `analytics_path` / `analytics_funnel` (多ページサイトで有効、CIP_QWa 7.38pv で実証)。

---

## B. Deep Research モード (設計確定・実装は別途)

**思想**: チャット応答(同期)では回せない数分の多段調査を、非同期ジョブで実行→結果保存→チャットが対話的に深掘り。

### 起動方式 (Owner決定: オンデマンド先行)
チャットを「調査の受付」にする。週次cronは後回し。
```
①ユーザー「深く調べて」/曖昧質問
 → ②チャットが軽い記述ツール + analytics_data_readiness で"何が取れるか"即判定
 → ③候補プラン提示「CV計測あり+フォーム1つ+複数ページ → A)フォーム離脱深掘り B)CV経路ボトルネック C)UI/UX課題監査」
 → ④ユーザー選択 → enqueue(非同期) → 完了通知
 → ⑤レポートをチャットで対話的に深掘り
```
新ツール2つ:
- `propose_deep_research` — `analytics_data_readiness` を見て候補プランを返す。
- `enqueue_deep_research` — 選択調査を `analysis_jobs` に積む (**書き込み=副作用**。ユーザー選択を明示確認後に実行)。

### アーキ (このスタックの現実に整合)
- 実行基盤 = **Vercel Cron** (`/api/cron/daily-site-summary` + `lib/llm/daily-summary.ts` が実証済テンプレ)。
  Inngest は installed-but-disabled、Vercel Queues 未導入 → v1 は Cron polling か `/api/jobs/run` 起動が最短。
  retry/長時間が要れば Inngest が升級パス。1ステージ上限 300s (`maxDuration`)。
- `/api/chat` の中では回さない (リクエスト応答型・rate-limited)。
- worker は read=analytics_reader / write=chat_writer (clickhouse.ts 3-role)。数値は構造化JSONで生成、LLM は文章化のみ。

### 新テーブル (Infra が手動 DDL 適用。自動migration無し)
- `clickinsight.analysis_jobs` — id / tenant_id(LowCardinality, ORDER BY先頭) / site_id / user_id / job_type /
  status(pending→running→completed/failed) / input_config(JSON) / output_results(Nullable JSON) / error_message /
  created_at / started_at / completed_at / duration_seconds / model_id / cost_usd。
  ENGINE=ReplacingMergeTree(updated_at) / PARTITION BY toYYYYMM(created_at) / TTL 180d。
- `clickinsight.proposal_tickets` — id / tenant_id / site_id / job_id / report_type /
  problem / evidence(JSON) / affected_segment / recommended_change / confidence / evidence_level /
  blocked_claims(Array) / query_refs(Array) / status / created_at / version。冪等キー=tenant+site+週+version。
  ENGINE=ReplacingMergeTree。**D-07: 推定 impact は inferred、observed と峻別**。

### レポート v1 (3本)
1. **UI/UX課題監査** (旧"パフォーマンスUXリスク"を一節に統合): FV/レイアウト・デッドゾーン・
   ナビ迷子(browser_back/scroll_reversal/tab_return)・モバイル固有(pinch_zoom)・速度(web_vitals p75 × 直帰proxy)。
2. **CTA/フォーム改善チケット**: element_visibility_v2 露出 × click(events) × hover-no-click(behavior_signals) + form 項目別離脱 + device別。
3. **注目→行動ギャップ**: read_area/attention 高 × click/フォーム進行 低のセクション特定。

### チケットの居場所 (Owner決定: M Agent)
- `proposal_tickets` は **M Agent 配下**に出す (観測→診断→チケット→M Agent介入→翌週効果測定 のループ)。
- 出口は M Agent「フォーム最適化」(`/scenarios/form`, 現 disabled stub) / バナー。
- チャットは生成・提示の窓口。行動分析の `action-tickets`(現 disabled) は本設計では使わず M Agent に一本化 (要 nav 整理)。

---

## C. ML/統計 ("時間をかけて"見えるもの)

Codex 結論: **統計は YES、ML はまだ NO** (CV=0/1ページ流入のパイロット形状に依存)。

| 区分 | 手法 | 判定 | 備考 |
|---|---|---|---|
| 今すぐ価値 | quantile/TDigest | 採用 | web_vitals/滞在/入力時間の分布 (一部既存) |
| 今すぐ価値 | **2比率検定・信頼区間** | 最優先 | before/after・セグメント比較。corrより価値高。TS or SQL |
| 今すぐ価値 | z-score/移動平均 (変化点lite) | 採用 | 異常検知v1 |
| 今すぐ価値 | median/MAD・p75/p90 外れ値 | 採用 | 平均より頑健 |
| 条件付き | corr (相関) | 限定 | サンプル閾値必須・「相関≠因果」明記 (既存 correlation 準拠) |
| 時期尚早 | stochasticLogisticRegression | 凍結 | ラベル(CV)不足 |
| 時期尚早 | クラスタリング | 凍結→ルールベース代替 (熟読/即離脱/CTAホバー/フォーム放棄) | |
| 危険 | 感情・意図推定 | 凍結 | D-07違反リスク。「行動proxyラベル」に留める |

**本物の予測/感情ML 前提**: ①CV/フォーム成功ラベルの継続記録 ②テナント毎 正例数百件 ③安定visitor識別
④予測時点の特徴量スナップショット(リーク防止) ⑤ホールドアウト検証 ⑥observed/inferred/predicted の文言分離。
→ 統計(有意差/CI/変化点/相関)は Deep Research レポート内の裏取りに Phase 2 で織り込む。ML本体は前提充足後。

---

## 実装順 / 依存

- 🥇 **Phase 1 (済)**: 単発6ツール + データ準備 + 400回帰テスト。検証: tsc/build green、本番SQL全検証、ローカル jest green。
  → Owner が `vercel deploy --prod` (AIは本番デプロイ不可) → チャットで実機テスト。
- 🥈 **Phase 2**: Deep Research v1 (UI/UX課題監査 + CTA/フォームチケット + 会話スコープ2ツール)。
  依存: `analysis_jobs`/`proposal_tickets` の Infra 手動 DDL、cron 登録 (vercel.json/vercel.ts)、deploy。
- 🥉 **Phase 3**: チャット→Deep Research の会話スコープ強化、ML/統計の裏取り織り込み。

## スコープ外 (別途)
- マルチユーザー(ID+パスワード)。ヒートマップ視覚調整 / image capture Worker デプロイ。
