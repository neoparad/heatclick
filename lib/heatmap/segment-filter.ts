/**
 * 行動セグメントの ClickHouse WHERE フラグメント生成 (続132: route.ts / elements/route.ts の
 * 二重定義を一本化した単一ソース)。
 *
 * 設計 (§3.8.1 / セキュリティ):
 *   - 返すのは **parameter binding 済みの定数 SQL 断片のみ**。ユーザー入力の文字列連結は一切なし
 *     (segment は型 union で enum 制約済み、値は switch で分岐する固定文字列)。
 *   - 全サブクエリは tenant_id / site_id を必ず束縛する (cross-tenant 遮断)。
 *   - 呼び出し側は queryParams に {tenant_id} {site_id} {page_url} {start} {end} を渡す前提
 *     (既存 4 セグメントと同じ契約)。returning / new は追加 param 不要 (visitor_id は events 列)。
 *
 * セグメント定義:
 *   - all       : 絞り込みなし
 *   - deep_read : そのページで max(scroll_percentage) >= 70 のセッション (熟読層)
 *   - bounce    : max(scroll_percentage) <= 20 (浅読・直帰層)
 *   - ad        : gclid / fbclid を伴うセッション (広告流入)
 *   - returning : visitor のサイト全体 初回来訪 (min timestamp) < 当該セッション開始 = 再訪 [続132]
 *   - new       : visitor の初回来訪が当該セッション = サイト初訪問 [続132]
 *
 * returning / new の注意:
 *   - visitor_id が空のセッションは判定不能 → returning / new どちらにも含めない (all のみ対象)。
 *   - 「初回来訪」は site_id 全体・全期間の min(timestamp) で判定 (GA の New/Returning と同義)。
 *     window 外の過去訪問も「再訪」として正しく拾う。集計は visitor_id (LowCardinality) 別 min で軽量。
 */

import type { HeatmapSegment } from '@/lib/api/heatmap'
import { canonicalUrlSql } from '@/lib/heatmap/canonical-url'

/**
 * returning / new の共通サブクエリ。`comparator` だけ差し替える。
 *   page_sessions : このページ・期間の (session_id, visitor_id, セッション開始時刻)
 *   visitor_first : visitor のサイト全体 初回来訪時刻
 *   join して first_seen <comparator> sess_start のセッションを返す。
 */
function visitorRecencyFilter(comparator: '<' | '>='): string {
  return `AND session_id IN (
    SELECT ps.session_id
    FROM (
      SELECT session_id, any(visitor_id) AS vid, min(timestamp) AS sess_start
      FROM clickinsight.events
      WHERE tenant_id = {tenant_id:String}
        AND site_id = {site_id:String}
        AND ${canonicalUrlSql('url')} = {page_url:String}
        AND is_agent = 0
        AND visitor_id != ''
        AND timestamp >= toDateTime({start:String})
        AND timestamp < toDateTime({end:String}) + INTERVAL 1 DAY
      GROUP BY session_id
    ) ps
    INNER JOIN (
      SELECT visitor_id, min(timestamp) AS first_seen
      FROM clickinsight.events
      WHERE tenant_id = {tenant_id:String}
        AND site_id = {site_id:String}
        AND visitor_id != ''
      GROUP BY visitor_id
    ) vf ON ps.vid = vf.visitor_id
    WHERE vf.first_seen ${comparator} ps.sess_start
  )`
}

export function segmentFilterSql(segment: HeatmapSegment): string {
  switch (segment) {
    case 'all':
      return ''
    case 'ad':
      return `AND session_id IN (
        SELECT DISTINCT session_id FROM clickinsight.events
        WHERE tenant_id = {tenant_id:String}
          AND site_id = {site_id:String}
          AND ${canonicalUrlSql('url')} = {page_url:String}
          AND is_agent = 0
          AND ((gclid IS NOT NULL AND gclid != '') OR (fbclid IS NOT NULL AND fbclid != ''))
          AND timestamp >= toDateTime({start:String})
          AND timestamp < toDateTime({end:String}) + INTERVAL 1 DAY
      )`
    case 'deep_read':
    case 'bounce': {
      const havingCond =
        segment === 'deep_read' ? 'max(scroll_percentage) >= 70' : 'max(scroll_percentage) <= 20'
      return `AND session_id IN (
        SELECT session_id FROM clickinsight.events
        WHERE tenant_id = {tenant_id:String}
          AND site_id = {site_id:String}
          AND ${canonicalUrlSql('url')} = {page_url:String}
          AND is_agent = 0
          AND timestamp >= toDateTime({start:String})
          AND timestamp < toDateTime({end:String}) + INTERVAL 1 DAY
        GROUP BY session_id
        HAVING ${havingCond}
      )`
    }
    // 続132: visitor のサイト全体 初回来訪 (first_seen) と当該セッション開始の前後で判定。
    case 'returning':
      return visitorRecencyFilter('<')
    case 'new':
      return visitorRecencyFilter('>=')
  }
}
