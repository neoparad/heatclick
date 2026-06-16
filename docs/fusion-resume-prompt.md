# 融合作業 再開プロンプト (コピペ用)

新しい `claude` セッションで、以下をそのまま貼り付ける。

---

融合パイプライン作業を再開する。まず `docs/fusion-handoff-2026-06-07.md` を読んで全体状況を把握して。要点:

- UGOKI MAP(行動) × linkscrawl(コンテンツ) 突合。対象: tenant `linkth_internal` / site `CIP_QWaPiks5krukJ6NM` (wakegai.jp) / crawl job `2d79f951-6030-4b6f-af66-57896df89f71`。
- 完了済: 6表DDL適用、content_map 62URL/2317行(selector+hash 100%)、export ドライランで section_behavior 116行・Zod契約PASS。
- linkscrawl Postgres は SSHトンネル `ssh -N -L 5433:localhost:5433 root@159.69.95.59` 経由(LISTENING確認済み前提)。ClickHouse は 159.69.95.59:8123/clickinsight、creds は ugokimap `.env.local`。

次の手は ①→②→③:
1. `linkscrawl/mcp_tools/crawl_export.py` の未コミット修正(page_performance/issues の実スキーマ整合)を Codex デュアルレビュー → linkscrawl(branch feature/serp-api)にローカルコミット(対象ファイルのみ、push しない)。
2. STEP4.5: wakegai(job 2d79f951...)に SEO/a11y 分析を流して `issues` を生成(現状0件) → 再 export で issues>0 を確認。
3. B 本番反映 STEP5–7(grants→env→linkscrawl deploy→`vercel deploy --prod`=Owner→fusion-ingest 起動→チャット動作確認)。

厳守: secrets非表示/非コミット、本番deployとGRANTはOwnerのみ、本番DDLはOwner承認時のみ、tenant_id常時保持、`_tmp_*`は使用後削除、旧 ugokimap app/* 触らない。

まず①から。`crawl_export.py` の diff を確認して、問題なければ Codex レビューに回して。

---
