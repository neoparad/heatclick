# Fusion B 本番反映 STEP5–7 Runbook (2026-06-07)

> Owner が手順に沿って実行するための runbook。AI は実行不可な領域 (deploy / GRANT / 本番秘密) を Owner に明示。
> 前提: ハンドオフ `docs/fusion-handoff-2026-06-07.md` の §1〜§4 を読了。①②は完了済。

## 0. これは何をするか (一言)
UGOKI Crawl の最新版を Hetzner にデプロイし、UGOKI MAP (Vercel) からの **6 時間ごとの自動 pull** が動くようにする。
最後にチャットに「直す順 (rank_behavior_validated_fixes)」を投げて、行動裏取りつきの提案が返ってくれば完了。

## 1. 完了基準 (これが揃えば終わり)
| # | 確認項目 | どこで見るか |
|---|---|---|
| 1 | linkscrawl API `GET /v1/fusion/export` が wakegai (job 2d79f951...) で 200 を返す | curl from Owner laptop |
| 2 | Vercel cron `/api/cron/fusion-ingest` が次回 0 分台でリクエストを受け、ok=1 を返す | Vercel Logs |
| 3 | ClickHouse `clickinsight.page_issues` の wakegai 行数が **>0** | clickhouse-client SELECT count |
| 4 | UGOKI MAP のチャットで「wakegai の直す順を出して」と聞くと **裏取り済 selector_hash** 入りの回答が返る | ugokimap.com UI |

完了基準 1〜3 = 配管確認、4 = ユーザ価値確認。**4 が通れば本タスク終了**。

---

## 2. STEP5: linkscrawl 本番デプロイ (Owner、所要 ~10 分)

### 2.1 何が乗るか
- 直近コミット `9f8f548 fix(fusion): crawl_export を実テーブルスキーマに整合`
- 含: `/v1/fusion/export` endpoint + `crawl_export_v1` builder (additive-only)
- 含まない: 新規 GRANT / DDL (STEP5.5 と STEP6 で別途)

### 2.2 Owner action
| 順 | コマンド (Owner laptop / Hetzner) | 期待結果 |
|----|---|----------------------------------|
| 1 | `cd C:\Users\M2603\linkscrawl && git log -1 --oneline` | `9f8f548 fix(fusion):...` |
| 2 | `git push origin feature/serp-api` | up to date / fast-forward |
| 3 | `ssh root@159.69.95.59 'cd /srv/linkscrawl && git fetch && git checkout feature/serp-api && git pull'` | up-to-date |
| 4 | `ssh root@159.69.95.59 'cd /srv/linkscrawl && docker compose -f deploy/docker-compose.crawler-api.yml up -d --build api'` | api container Up |
| 5 | `ssh root@159.69.95.59 'curl -s http://localhost:8000/v1/fusion/export?tenant_id=x&site_id=y&job_id=z'` | **HTTP 503** (env未投入で機能無効=正しい) |

> 5 で 503 が正しい。`FUSION_EXPORT_TOKEN` が無いと endpoint は自分自身を無効化する設計 (api/fusion_routes.py:25)。STEP5.5 で env を入れる。

### 2.3 ロールバック (失敗時)
```
ssh root@159.69.95.59 'cd /srv/linkscrawl && git checkout <前commit> && docker compose -f deploy/docker-compose.crawler-api.yml up -d --build api'
```

---

## 3. STEP5.5: env / GRANT 投入 (Owner、所要 ~10 分)

### 3.1 linkscrawl 側 env (Hetzner `.env` または compose の environment)
| 名前 | 値 | 用途 |
|------|----|------|
| `FUSION_EXPORT_TOKEN` | **新規生成** 32+ 文字、URL-safe (`openssl rand -base64 32` 等) | UGOKI MAP との共有トークン (同じ値を ugokimap にも入れる) |

> 値は Owner が **1Password / .env のみ** で保管。Slack / Issue / チャットには貼らない。

### 3.2 ugokimap-saas 側 env (Vercel Project Env、Production のみ)
| 名前 | 値 | 用途 |
|------|----|------|
| `UGOKICRAWL_API_URL` | `https://api.linkscrawl.<domain>` (Caddy 経由の公開 URL) | export endpoint ベース URL |
| `FUSION_EXPORT_TOKEN` | **STEP3.1 と同じ値** | X-Fusion-Token ヘッダで送る |
| `FUSION_INGEST_TARGETS` | `[{"tenantId":"linkth_internal","siteId":"CIP_QWaPiks5krukJ6NM","jobId":"2d79f951-6030-4b6f-af66-57896df89f71","days":30}]` | 取り込み対象 (JSON array) |
| `CRON_SECRET` | 既存 (deep-research と共有可) | 手動トリガ時の `x-cron-secret` ヘッダ |
| `CLICKHOUSE_*` (writer/reader 系) | 既存 (chat-writer 用、SB-1 の rotation 後に更新) | INSERT/SELECT 用 |

> Vercel UI: Project → Settings → Environment Variables → Production にのみ追加。Preview/Development には**入れない** (本番秘密の漏洩面を最小化)。

### 3.3 ClickHouse GRANT (Infra/Owner、SQL は migration コメントから抜粋)
```sql
GRANT SELECT ON clickinsight.crawl_runs, clickinsight.page_content_sections,
  clickinsight.page_performance, clickinsight.page_issues,
  clickinsight.section_behavior_summary
TO analytics_reader;

GRANT INSERT, SELECT ON clickinsight.crawl_runs, clickinsight.page_content_sections,
  clickinsight.page_performance, clickinsight.page_issues,
  clickinsight.section_behavior_summary
TO chat_writer;
```
> 実行: `clickhouse-client --user default --password "$CLICKHOUSE_PASSWORD"` で 1 文ずつ流す。
> `analytics_reader` / `chat_writer` ロールが既存であることを前提 (mini-saas で導入済)。

### 3.4 Pre-flight check (Owner、env 投入後)
| # | コマンド | 期待 |
|---|----------|------|
| a | `ssh root@159.69.95.59 'docker compose ... exec api env | grep FUSION_EXPORT_TOKEN | wc -c'` | **>16** (値長確認・値自体は出さない) |
| b | `curl -s -H "X-Fusion-Token: $TOKEN" 'https://api.linkscrawl.<domain>/v1/fusion/export?tenant_id=linkth_internal&site_id=CIP_QWaPiks5krukJ6NM&job_id=2d79f951-6030-4b6f-af66-57896df89f71&days=30' | jq '.schema_version,(.sections|length),(.issues|length),(.section_behavior|length)'` | `"v1" 2317 6843 116` |

> b が通れば配管完了。

---

## 4. STEP6: Vercel 本番デプロイ (Owner only、所要 ~5 分)

### 4.1 Owner action
| 順 | コマンド | 期待 |
|----|----------|------|
| 1 | `cd C:\Users\M2603\ugokimap-saas && git status` | clean |
| 2 | `vercel deploy --prod` (Owner laptop、Vercel CLI 認証済) | `https://ugokimap.com` deploy 完了 |
| 3 | `vercel env ls production | grep -E 'FUSION_|UGOKICRAWL_|CRON_'` | 4 件全て **Encrypted** |

> 注: AI は `vercel deploy --prod` を実行**しない** (CLAUDE.md 絶対ルール 5)。worktree からも禁止。

### 4.2 deploy 直後の smoke (AI or Owner)
```
curl -X POST -H "x-cron-secret: $CRON_SECRET" \
  https://ugokimap.com/api/cron/fusion-ingest | jq
```
期待:
```json
{
  "success": true,
  "data": {
    "targets": 1, "ok": 1, "failed": 0,
    "results": [{"site": "CIP_QWaPiks5krukJ6NM", "ok": true, "inserted": {...}}],
    "elapsedMs": <数千>
  }
}
```

---

## 5. STEP7: 動作確認 (AI 可、所要 ~5 分)

### 5.1 ClickHouse 書き込み確認
```
clickhouse-client --user analytics_reader -q "
SELECT
  countIf(table='page_issues') AS issues,
  countIf(table='page_content_sections') AS sections,
  countIf(table='section_behavior_summary') AS sb
FROM (
  SELECT 'page_issues' AS table FROM clickinsight.page_issues
   WHERE tenant_id='linkth_internal' AND site_id='CIP_QWaPiks5krukJ6NM'
  UNION ALL SELECT 'page_content_sections' FROM clickinsight.page_content_sections
   WHERE tenant_id='linkth_internal' AND site_id='CIP_QWaPiks5krukJ6NM'
  UNION ALL SELECT 'section_behavior_summary' FROM clickinsight.section_behavior_summary
   WHERE tenant_id='linkth_internal' AND site_id='CIP_QWaPiks5krukJ6NM'
)"
```
期待: `issues>=6800, sections=2317, sb=116` (ingest 1 回目)。

### 5.2 チャットツール疎通 (UGOKI MAP UI)
1. ugokimap.com にログイン (tenant: linkth_internal)
2. ダッシュボードのチャットで聞く: **「wakegai の直す順を 5 件出して」**
3. 期待: `rank_behavior_validated_fixes` が呼ばれ、回答に
   - **Evidence Level バッジ** (`proven` / `observed`)
   - **selector_hash** または **viewport 別 y_range**
   - **friction_score / dead_clicks / rage_clicks** の実値
   が含まれる。

### 5.3 ロールバック判断
- 5.1 で `issues=0` → linkscrawl /v1/fusion/export が 200 で空 array、または ingest 認可失敗。**Vercel Logs** を確認。
- 5.2 でチャットがスキーマエラー → ingest がスキップ済の可能性。`vercel logs --prod` で `[cron/fusion-ingest]` 出力を見る。
- どちらも `vercel deploy --prod` をひとつ戻すだけで rollback 可。

---

## 6. 厳守事項 (再掲)
- AI が触らない: **GRANT、vercel deploy --prod、本番 DDL、`.env` 値の表示**
- 秘密は `.env` / Vercel Project Env のみ。Slack / Issue / チャットに**貼らない**
- 値長確認は OK (`wc -c`)、値表示は **NG**
- ロールバックは destructive ではない (deploy 戻し / commit revert / GRANT REVOKE)

## 7. 関連
- 設計: `ugokimap-saas/docs/ugokicrawl-fusion-implementation-plan.md` §12 実測ログ
- 引き継ぎ: `ugokimap-saas/docs/fusion-handoff-2026-06-07.md`
- Security: `linkscrawl/docs/fusion/team/security-backlog-2026-06-07.md` (SB-1: CH password rotation、STEP3.3 と並行で対処可)
