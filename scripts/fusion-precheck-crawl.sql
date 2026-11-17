-- fusion-precheck-crawl.sql — 行動×構造の突合 段階1 着手前の確認 (クロール側、読み取り専用)
--
-- 仕様: docs/proposals/2026-11-12-fusion-stage1-fix-priority-spec.md §6 の 2・4・5
-- 対象: LINKTH CRAWL (linkscrawl) の PostgreSQL。SELECT のみ。
-- 実行: psql "<クロール側の接続文字列>" -f scripts/fusion-precheck-crawl.sql
--
-- 表と列は linkscrawl/shared/database_integration.py の定義 (crawl_jobs / analysis_jobs / issues) に基づく。
-- 実データベースでは未実行。列が違う場合はエラーになるだけで、何も変更しない。

-- ── A. 対象媒体ごとのクロール (新しい順に3件) ──────────────────────────
--    §6 の 2: サイト台帳に登録するジョブIDの候補。
WITH jobs AS (
  SELECT id, status, pages_crawled, completed_at, created_at,
         lower(split_part(regexp_replace(target_url, '^https?://(www\.)?', ''), '/', 1)) AS host
  FROM crawl_jobs
),
ranked AS (
  SELECT *, row_number() OVER (PARTITION BY host ORDER BY COALESCE(completed_at, created_at) DESC) AS rn
  FROM jobs
  WHERE host IN ('wakegai.jp', 'bihadashop.jp', 'bousuikouji.info', 'nvrseen.com', 'link-th.co.jp', 'ehaiki.jp')
)
SELECT host, id AS job_id, status, pages_crawled, completed_at, created_at
FROM ranked
WHERE rn <= 3
ORDER BY host, rn;

-- ── B. 最新の完了クロールで検出された課題の種類と件数 ──────────────────
--    §6 の 5: 「課題の種類 → 突き合わせる行動」の対応表を確定させる材料。
WITH jobs AS (
  SELECT id, completed_at,
         lower(split_part(regexp_replace(target_url, '^https?://(www\.)?', ''), '/', 1)) AS host
  FROM crawl_jobs
  WHERE completed_at IS NOT NULL
),
latest AS (
  SELECT DISTINCT ON (host) host, id
  FROM jobs
  WHERE host IN ('wakegai.jp', 'bihadashop.jp', 'bousuikouji.info', 'nvrseen.com', 'link-th.co.jp', 'ehaiki.jp')
  ORDER BY host, completed_at DESC
)
SELECT l.host,
       i.issue_type,
       i.severity,
       count(*) AS rows,
       count(DISTINCT COALESCE(i.url, i.affected_url)) AS pages,
       count(*) FILTER (
         WHERE jsonb_typeof(i.details) = 'object'
           AND (i.details ? 'selector' OR i.details ? 'element_selector')
       ) AS with_selector
FROM issues i
LEFT JOIN analysis_jobs aj ON aj.id = i.analysis_job_id
JOIN latest l ON l.id = COALESCE(i.job_id, aj.crawl_job_id)
GROUP BY l.host, i.issue_type, i.severity
ORDER BY l.host, rows DESC;

-- ── C. 課題の詳細に入っている項目名 ────────────────────────────────────
--    §6 の 4: リンク切れのリンク先や要素の指定が、詳細の中に残っているか。
WITH jobs AS (
  SELECT id, completed_at,
         lower(split_part(regexp_replace(target_url, '^https?://(www\.)?', ''), '/', 1)) AS host
  FROM crawl_jobs
  WHERE completed_at IS NOT NULL
),
latest AS (
  SELECT DISTINCT ON (host) host, id
  FROM jobs
  WHERE host IN ('wakegai.jp', 'bihadashop.jp', 'bousuikouji.info', 'nvrseen.com', 'link-th.co.jp', 'ehaiki.jp')
  ORDER BY host, completed_at DESC
)
SELECT i.issue_type, k.detail_key, count(*) AS rows
FROM issues i
LEFT JOIN analysis_jobs aj ON aj.id = i.analysis_job_id
JOIN latest l ON l.id = COALESCE(i.job_id, aj.crawl_job_id)
CROSS JOIN LATERAL jsonb_object_keys(
  CASE WHEN jsonb_typeof(i.details) = 'object' THEN i.details ELSE '{}'::jsonb END
) AS k(detail_key)
GROUP BY i.issue_type, k.detail_key
ORDER BY i.issue_type, rows DESC;
