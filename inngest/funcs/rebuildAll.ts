import { inngest } from "../client";
import { getClickHouseClientAsync } from "../lib/clickhouse";

export const rebuildAll = inngest.createFunction(
  { 
    id: "rebuild-all-heatmap-summary",
    name: "Rebuild Heatmap Summary (Full)" 
  },
  { event: "heatmap.rebuild" },
  async ({ event, step }) => {
    return await step.run("rebuild-all-data", async () => {
      const client = await getClickHouseClientAsync();

      // 既存データをクリア（オプション）
      await client.exec({
        query: `TRUNCATE TABLE IF EXISTS clickinsight.heatmap_daily_summary`,
      });

      // 全データを集約
      const query = `
        INSERT INTO clickinsight.heatmap_daily_summary
        SELECT
          site_id,
          url AS page_url,
          coalesce(device_type, 'unknown') AS device_type,
          event_type,
          toDate(timestamp) AS date,
          click_x,
          click_y,
          count() AS click_count,
          uniq(session_id) AS unique_sessions,
          now() AS last_updated
        FROM clickinsight.events
        WHERE event_type = 'click'
          AND click_x > 0
          AND click_y > 0
        GROUP BY site_id, page_url, device_type, event_type, date, click_x, click_y
      `;

      await client.query({
        query,
        format: 'JSONEachRow',
      });

      return { status: "completed", message: "All heatmap data rebuilt" };
    });
  }
);

