import { getClickHouseClientAsync } from "./clickhouse";

interface GetHeatmapDataParams {
  siteId: string;
  pageUrl: string;
  deviceType?: string;
  heatmapType?: 'click' | 'scroll' | 'read';
  startDate?: string;
  endDate?: string;
}

export async function getHeatmapData({
  siteId,
  pageUrl,
  deviceType,
  heatmapType = 'click',
  startDate,
  endDate,
}: GetHeatmapDataParams): Promise<any[]> {
  const client = await getClickHouseClientAsync();

  if (heatmapType === 'click') {
    // 集約テーブルから取得
    let query = `
      SELECT
        click_x,
        click_y,
        sum(click_count) AS click_count,
        sum(unique_sessions) AS session_count,
        max(last_updated) AS last_updated
      FROM clickinsight.heatmap_daily_summary
      WHERE site_id = {site_id:String}
        AND page_url = {page_url:String}
        AND event_type = 'click'
    `;

    const params: Record<string, any> = {
      site_id: siteId,
      page_url: pageUrl,
    };

    if (deviceType) {
      query += ` AND device_type = {device_type:String}`;
      params.device_type = deviceType;
    }

    if (startDate && endDate) {
      query += ` AND date BETWEEN toDate({start_date:String}) AND toDate({end_date:String})`;
      params.start_date = startDate;
      params.end_date = endDate;
    }

    query += `
      GROUP BY click_x, click_y
      HAVING click_count >= 3
      ORDER BY click_count DESC
      LIMIT 1000
    `;

    const result = await client.query({
      query,
      query_params: params,
      format: "JSONEachRow",
    });

    const data = await result.json() as any[];

    return data.map(item => ({
      click_x: Number(item.click_x) || 0,
      click_y: Number(item.click_y) || 0,
      count: Number(item.click_count) || 0,
      click_count: Number(item.click_count) || 0,
      unique_sessions: Number(item.session_count) || 0,
      last_click: item.last_updated,
    }));
  }

  // スクロール・熟読ヒートマップは既存ロジックを使用
  // （heatmap_eventsテーブルから取得）
  // ここでは省略（既存のgetHeatmapData関数を参照）
  return [];
}

// 人気ページを取得（キャッシュウォーミング用）
export async function getPopularPages(limit: number = 100): Promise<Array<{ site_id: string; page_url: string }>> {
  const client = await getClickHouseClientAsync();
  
  const query = `
    SELECT DISTINCT
      site_id,
      url AS page_url
    FROM clickinsight.events
    WHERE event_type = 'click'
      AND timestamp >= now() - INTERVAL 30 DAY
    GROUP BY site_id, page_url
    ORDER BY count() DESC
    LIMIT {limit:UInt32}
  `;

  const result = await client.query({
    query,
    query_params: { limit },
    format: "JSONEachRow",
  });

  return await result.json() as Array<{ site_id: string; page_url: string }>;
}


