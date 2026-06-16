-- ════════════════════════════════════════════════════════════════════
-- image_visibility テーブルへの analytics_reader SELECT 権限付与
-- ════════════════════════════════════════════════════════════════════
-- 対象: Hetzner ClickHouse / DB=clickinsight
-- 適用: Infra Engineer / Owner が手動で実行
--
-- 背景 (続130):
--   app/api/heatmap/elements/route.ts の image_visibility クエリが
--   analytics_reader の SELECT grant 欠落により 497 エラーを出し、
--   画像視認スポット (imageSpots) が常に [] になっていた。
--   route は try/catch で [] に degrade し、UI には「ホバーが何も出ない」として表示される。
--   (③: 「画像にカーソルを合わせると視認率が分かるはずが機能しない」の根本原因)
--
-- 確認コマンド (適用後):
--   SHOW GRANTS FOR analytics_reader;
--   SELECT count() FROM clickinsight.image_visibility LIMIT 1;  -- analytics_reader で実行
-- ════════════════════════════════════════════════════════════════════

GRANT SELECT ON clickinsight.image_visibility TO analytics_reader;

-- 確認:
--   SHOW GRANTS FOR analytics_reader;
