import { inngest } from "../client";
import { getClickHouseClientAsync } from "../lib/clickhouse";

export const rebuildAll = inngest.createFunction(
  { 
    id: "rebuild-all-heatmap-summary",
    name: "Rebuild Heatmap Summary (Full)",
    retries: 0, // リトライを無効化（手動で再実行する方が安全）
  },
  { event: "heatmap.rebuild" },
  async ({ event, step }) => {
    // ステップ1: ClickHouse接続確認
    const connectionResult = await step.run("check-connection", async () => {
      try {
        const client = await getClickHouseClientAsync();
        
        // 接続テスト
        await client.query({
          query: "SELECT 1",
          format: "JSONEachRow",
        });
        
        console.log("ClickHouse接続確認成功");
        return { connected: true };
      } catch (error: any) {
        console.error("ClickHouse接続エラー:", {
          message: error?.message || String(error),
          code: error?.code,
          stack: error?.stack,
        });
        throw new Error(`ClickHouse接続エラー: ${error?.message || String(error)}`);
      }
    });

    // ステップ2: テーブルクリア
    const truncateResult = await step.run("truncate-table", async () => {
      try {
        const client = await getClickHouseClientAsync();
        
        // 既存データをクリア（オプション）
        await client.exec({
          query: `TRUNCATE TABLE IF EXISTS clickinsight.heatmap_daily_summary`,
        });
        
        console.log("テーブルをクリアしました");
        return { truncated: true };
      } catch (error: any) {
        console.error("テーブルクリアエラー:", {
          message: error?.message || String(error),
          code: error?.code,
        });
        // クリアエラーは無視して続行（テーブルが存在しない場合など）
        return { truncated: false, error: error?.message };
      }
    });

    // ステップ3: データ集約
    const rebuildResult = await step.run("rebuild-all-data", async () => {
      try {
        const client = await getClickHouseClientAsync();

        // まず、処理対象の日付範囲を取得
        const dateRangeQuery = `
          SELECT 
            min(toDate(timestamp)) as min_date,
            max(toDate(timestamp)) as max_date,
            count() as total_events
          FROM clickinsight.events
          WHERE event_type = 'click'
            AND click_x > 0
            AND click_y > 0
        `;
        
        const dateRangeResult = await client.query({
          query: dateRangeQuery,
          format: "JSONEachRow",
        });
        const dateRange = await dateRangeResult.json() as any[];
        const dateInfo = dateRange[0] as any;

        console.log("処理対象データ:", {
          min_date: dateInfo?.min_date,
          max_date: dateInfo?.max_date,
          total_events: dateInfo?.total_events,
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

        console.log("集約クエリを実行中...");
        await client.query({
          query,
          format: 'JSONEachRow',
        });

        // 結果を確認
        const countQuery = `SELECT count() as count FROM clickinsight.heatmap_daily_summary`;
        const countResult = await client.query({
          query: countQuery,
          format: "JSONEachRow",
        });
        const countData = await countResult.json() as any[];
        const rowCount = (countData[0] as any)?.count || 0;

        console.log("集約完了:", { rowCount });

        return { 
          status: "completed", 
          message: "All heatmap data rebuilt",
          rowCount: Number(rowCount),
          dateRange: {
            min: dateInfo?.min_date,
            max: dateInfo?.max_date,
          },
        };
      } catch (error: any) {
        console.error("データ集約エラー:", {
          message: error?.message || String(error),
          code: error?.code,
          stack: error?.stack,
        });
        throw new Error(`データ集約エラー: ${error?.message || String(error)}`);
      }
    });

    return {
      connection: connectionResult,
      truncate: truncateResult,
      rebuild: rebuildResult,
    };
  }
);

