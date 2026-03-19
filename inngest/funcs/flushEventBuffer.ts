import { inngest } from "../client";
import { getClickHouseClientAsync } from "../lib/clickhouse";
import { popEventBuffer, pushRetryBuffer, popRetryBuffer, getEventBufferLength } from "@/lib/redis";

// 1分ごとにRedisバッファからClickHouseへフラッシュ
export const flushEventBuffer = inngest.createFunction(
  {
    id: "flush-event-buffer",
    name: "Flush Event Buffer to ClickHouse",
    retries: 2,
  },
  { cron: "* * * * *" }, // 毎分実行
  async ({ event, step }) => {
    // Step 1: メインバッファのフラッシュ
    const mainResult = await step.run("flush-main-buffer", async () => {
      const items = await popEventBuffer(500);
      if (items.length === 0) return { flushed: 0, failed: 0 };

      const client = await getClickHouseClientAsync();
      let flushed = 0;
      let failed = 0;

      // テーブルごとにグループ化してバッチINSERT
      const grouped: Record<string, any[]> = {};
      for (const item of items) {
        if (!grouped[item.table]) grouped[item.table] = [];
        grouped[item.table].push(...item.values);
      }

      for (const [table, values] of Object.entries(grouped)) {
        try {
          await client.insert({
            table,
            values,
            format: "JSONEachRow",
          });
          flushed += values.length;
        } catch (error: any) {
          console.error(`Failed to flush ${table}:`, error?.message);
          failed += values.length;
          // リトライバッファに戻す
          await pushRetryBuffer(table, values);
        }
      }

      return { flushed, failed };
    });

    // Step 2: リトライバッファの処理（5分に1回程度）
    const retryResult = await step.run("flush-retry-buffer", async () => {
      const items = await popRetryBuffer(100);
      if (items.length === 0) return { retried: 0, failed: 0 };

      const client = await getClickHouseClientAsync();
      let retried = 0;
      let failed = 0;

      const grouped: Record<string, any[]> = {};
      for (const item of items) {
        if (!grouped[item.table]) grouped[item.table] = [];
        grouped[item.table].push(...item.values);
      }

      for (const [table, values] of Object.entries(grouped)) {
        try {
          await client.insert({
            table,
            values,
            format: "JSONEachRow",
          });
          retried += values.length;
        } catch (error: any) {
          console.error(`Retry failed for ${table}:`, error?.message);
          failed += values.length;
          // 2回目の失敗はログに記録して破棄（無限ループ防止）
          console.error(`Permanently dropped ${values.length} events for ${table}`);
        }
      }

      return { retried, failed };
    });

    const bufferLength = await step.run("check-buffer-size", async () => {
      return await getEventBufferLength();
    });

    return {
      main: mainResult,
      retry: retryResult,
      remainingBuffer: bufferLength,
    };
  }
);
