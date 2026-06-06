-- ════════════════════════════════════════════════════════════════════
-- Deep Research テーブルへの role 権限付与
-- ════════════════════════════════════════════════════════════════════
-- 対象: Hetzner ClickHouse / DB=clickinsight
-- 適用: Infra Engineer / Owner が手動で実行 (GRANT = アクセス制御変更のため AI は実行しない)。
--
-- 既存 3-role 構成 (lib/clickhouse.ts):
--   analytics_reader : SELECT のみ (チャット集計・worker のジョブ取得/結果読取)
--   chat_writer      : INSERT (worker のジョブ更新・チケット書込、enqueue ツール)
--
-- daily_site_summaries / llm_audit_ledger と同様に、新2テーブルにも grant が必要。
-- ════════════════════════════════════════════════════════════════════

GRANT SELECT ON clickinsight.analysis_jobs    TO analytics_reader;
GRANT SELECT ON clickinsight.proposal_tickets TO analytics_reader;

GRANT INSERT, SELECT ON clickinsight.analysis_jobs    TO chat_writer;
GRANT INSERT, SELECT ON clickinsight.proposal_tickets TO chat_writer;

-- 確認:
--   SHOW GRANTS FOR analytics_reader;
--   SHOW GRANTS FOR chat_writer;
