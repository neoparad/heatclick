import { inngest } from "../client";
import { getClickHouseClientAsync } from "../lib/clickhouse";

export const aggregateDaily = inngest.createFunction(
  { 
    id: "daily-heatmap-aggregation",
    name: "Daily Heatmap Aggregation" 
  },
  { cron: "0 4 * * *" }, // 日本時間 13:00（UTC 4:00）
  async ({ event, step }) => {
    return await step.run("aggregate-yesterday", async () => {
      // 昨日の範囲
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);
      const dateStr = yesterday.toISOString().split("T")[0];

      const client = await getClickHouseClientAsync();

      // ClickHouse 集約クエリ
      // パラメータ化クエリを使用（SQLインジェクション対策）
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
        WHERE toDate(timestamp) = toDate({date:String})
          AND event_type = 'click'
          AND click_x > 0
          AND click_y > 0
        GROUP BY site_id, page_url, device_type, event_type, date, click_x, click_y
      `;

      // execメソッドはquery_paramsをサポートしていないため、queryメソッドを使用
      // INSERT INTO ... SELECT は query メソッドで実行可能
      await client.query({
        query,
        query_params: { date: dateStr },
        format: 'JSONEachRow',
      });

      return { status: "ok", date: dateStr };
    });
  }
);

