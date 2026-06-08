# 融合パイプライン 引き継ぎメモ (2026-06-07)

> 別ターミナル/別デバイスでこの作業を**コールドで再開**するための自己完結メモ。
> 関連: `docs/ugokicrawl-fusion-implementation-plan.md`（設計・§12に実測ログ）/ プラン `.claude/plans/glistening-churning-rose.md`。

## 0. これは何か
UGOKI MAP(行動) × UGOKI Crawl/linkscrawl(コンテンツ) を突合し、チャットに
**「行動で裏取りした"直す順"(Behavior-Validated Fix Prioritization)」** を出す統合。
リポ2つ: `C:\Users\M2603\ugokimap-saas`(Next.js/TS, 私=AIの主作業) / `C:\Users\M2603\linkscrawl`(Python, クローラ/ML, branch `feature/serp-api`)。

## 1. 対象データの座標 (固定値)
- tenant_id: `linkth_internal`
- site_id: `CIP_QWaPiks5krukJ6NM` (サイト: wakegai.jp)
- crawl job_id: `2d79f951-6030-4b6f-af66-57896df89f71`
- ClickHouse: `http://159.69.95.59:8123` / DB `clickinsight` (events はここ。creds は ugokimap `.env.local`)
- Postgres(linkscrawl 本番): **SSHトンネル経由**
  - `ssh -N -L 5433:localhost:5433 root@159.69.95.59`
  - linkscrawl `.env` の `DATABASE_URL` は `127.0.0.1:5433` を指す。トンネルが無いと PG 作業は全て失敗。
  - 確認: `netstat -ano | findstr 5433` で LISTENING が出ること。

## 2. 完了済み (検証済みファクト)
- **6テーブル DDL 適用済み** (本番): ClickHouse 5表 (`crawl_runs` / `page_content_sections` / `page_performance` / `page_issues` / `section_behavior_summary`) + Postgres `intervention_events`(021) + `page_content_map` 列追加(022)。
- **content_map 規模拡大 (STEP4) 完了**: 行動イベントを持つ wakegai 62 URL を desktop+mobile でマップ。
  - `page_content_map`: distinct URL **62** / 総行 **2,317** (desktop 1,219 / mobile 1,098)
  - selector+hash 充填 **100%** / text_hash 充填 **100%**
- **export ドライラン (A) 完了 + 契約検証 PASS**:
  - `crawl_export_v1` を `build_crawl_export()` で実データ生成 → sections **2,317** / section_behavior **116**(61/62 URL) / performance 0 / issues 0
  - ugokimap の本物の Zod `crawlExportV1Schema.safeParse` を **通過**(jest で 1:1 検証済み)。
  - **行動×コンテンツ融合が実データで成立**(friction_score/dead/rage/viewport/selector_hash 実値)。

## 3. ⚠ 未コミットの修正 (最優先で固める = 次の①)
**`linkscrawl/mcp_tools/crawl_export.py`** をドライランで見つけた**実スキーマ不一致2件**に合わせて修正済み・**未コミット**:
- `page_performance`: 実テーブルに `strategy/inp_ms/measured_at` 無し → `mobile_score/desktop_score`,`crawled_at`,INP=0,viewport別出力に修正。
- `issues`: `affected_url/recommendation/impact_score`,`job_id`直結は誤 → `url/created_at/details(jsonb)` を `analysis_jobs.crawl_job_id` 経由JOINに修正。`_as_dict` ヘルパ追加。
- T1(データ契約)相当 → **Codex デュアルレビュー → linkscrawl にローカルコミット**(push は Owner)。

## 4. 次の手 ①→②→③
1. **`crawl_export.py` を Codex レビュー → ローカルコミット**(branch `feature/serp-api`、対象ファイルのみ。push しない)。
2. **STEP4.5: wakegai に SEO/a11y 分析を流して `issues` を生成**。
   - 現状 wakegai の issues=0(他サイト分5,559件のみ)。issues が無いと `rank_behavior_validated_fixes` は摩擦のみで弱い。
   - linkscrawl の分析パイプライン(163 issue types)を job `2d79f951...` に対し実行 → issues 投入 → 再 export で issues>0 を確認。
3. **B 本番反映 (STEP5–7)**:
   - STEP2 grants(Infra/Owner): ClickHouse `analytics_reader` SELECT / `chat_writer` INSERT を融合5表に。
   - STEP3 env: linkscrawl `FUSION_EXPORT_TOKEN`(≥16字) / ugokimap `UGOKICRAWL_API_URL`,`FUSION_EXPORT_TOKEN`,`FUSION_INGEST_TARGETS`(JSON [{tenantId,siteId,jobId,days}]),`CRON_SECRET`,`CLICKHOUSE_*` writer/reader。
   - STEP5 linkscrawl デプロイ(`/v1/fusion/export` 公開) = Owner。
   - STEP6 ugokimap `vercel deploy --prod` = **Owner本人のみ**。
   - STEP7 fusion-ingest 起動 → CH5表に投入 → チャットツール動作確認(`rank_behavior_validated_fixes`/`explain_section_friction`)。

## 5. 重要な発見 (設計に効く・§12詳細)
- **セレクタ突合は現状書式では発火しない**(構造的不一致: `>`空白有無 / `nth-child`↔`nth-of-type` / class有無 / 実ブラウザの注入で序数ズレ)。
  → v1 は **viewport別 y-range が主突合**(実測 25/25=100%)。低 confidence は「裏取り済」表示しない。
- **集客LPは URL の utm/fragment で突合から漏れる**(akiya2 24万 / akiya5 21万 events)。
  → `element_matcher.load_events_with_y` の `url=` 比較と URL別グループ化を**URL正規化キー**(query/fragment除去)に変更が必要(additive・次フェーズ)。LP融合の前提。

## 6. 厳守ルール (プロセス/セキュリティ)
- secrets は `.env.local`/`.env` のみ。git にコミットしない。値を表示しない。
- 本番 `vercel deploy --prod` は **Owner本人のみ**。AIは実行しない。
- GRANT(アクセス制御変更)は AI 実行不可 → Infra/Owner。
- 本番DDL適用は **Owner明示承認**があった時のみ(既適用分は承認済)。
- linkscrawl は別リポ・push は Owner。worktree からデプロイ禁止。旧 ugokimap `app/*` 触らない(D-01)。
- tenant_id を全 DB 操作で保持・検証。AI insight には Evidence Level 必須(D-07)。
- 一時スクリプト `_tmp_*` は使用後に必ず削除。

## 7. 再開時の最初の3コマンド
```
# 1) トンネル (別ペイン常駐)
ssh -N -L 5433:localhost:5433 root@159.69.95.59
# 2) 確認
netstat -ano | findstr 5433     # LISTENING が出ること
# 3) Claude 起動して下記「再開プロンプト」を貼る
cd C:\Users\M2603\ugokimap-saas && claude
```
