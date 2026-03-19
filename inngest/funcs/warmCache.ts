import { inngest } from "../client";
import { getHeatmapData, getPopularPages } from "../lib/heatmapQuery";
import { redis as getRedisClient } from "@/lib/redis";
import { getHeatmapData as getHeatmapDataLegacy } from "@/lib/clickhouse";

export const warmCache = inngest.createFunction(
  {
    id: "heatmap-cache-warming",
    name: "Heatmap Cache Warming"
  },
  { cron: "0 */6 * * *" }, // 6時間ごと
  async ({ event, step }) => {
    return await step.run("warm-cache", async () => {
      const popularPages = await getPopularPages(100);

      const ranges = [
        { start: null, end: null, label: "all" },
        { start: 7, end: 0, label: "7d" },
        { start: 30, end: 0, label: "30d" },
      ];

      const deviceTypes = ["desktop", "tablet", "mobile"];
      const heatmapTypes: Array<"click" | "scroll" | "read"> = ["click", "scroll", "read"];

      const redis = getRedisClient();
      let warmed = 0;

      for (const page of popularPages) {
        for (const range of ranges) {
          const endDate = new Date();
          const startDate = range.start
            ? new Date(endDate.getTime() - range.start * 24 * 60 * 60 * 1000)
            : null;

          for (const device of deviceTypes) {
            for (const heatmap of heatmapTypes) {
              try {
                let data: any[];

                if (heatmap === "click") {
                  // クリックは集約テーブルから取得
                  data = await getHeatmapData({
                    siteId: page.site_id,
                    pageUrl: page.page_url,
                    deviceType: device,
                    heatmapType: heatmap,
                    startDate: startDate?.toISOString().slice(0, 10),
                    endDate: endDate.toISOString().slice(0, 10),
                  });
                } else {
                  // スクロール・熟読はeventsテーブルから取得
                  data = await getHeatmapDataLegacy(
                    page.site_id,
                    page.page_url,
                    device,
                    startDate?.toISOString().slice(0, 10),
                    endDate.toISOString().slice(0, 10),
                    heatmap
                  );
                }

                if (data && data.length > 0) {
                  const key = `heatmap:v2:${page.site_id}:${page.page_url}:${device}:${heatmap}:${range.label}`;
                  await redis.setex(key, 6 * 3600, JSON.stringify(data));
                  warmed++;
                }
              } catch (e) {
                // 個別のキャッシュ失敗は無視して次へ
                console.error(`warmCache error: ${page.page_url} ${device} ${heatmap}`, e);
              }
            }
          }
        }
      }

      return { warmed, pages: popularPages.length };
    });
  }
);
