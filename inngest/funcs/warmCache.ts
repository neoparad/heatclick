import { inngest } from "../client";
import { getHeatmapData, getPopularPages } from "../lib/heatmapQuery";
import { getRedisClient } from "@/lib/redis";

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

      const redis = getRedisClient();
      let warmed = 0;

      for (const page of popularPages) {
        for (const range of ranges) {
          const endDate = new Date();
          const startDate = range.start 
            ? new Date(endDate.getTime() - range.start * 24 * 60 * 60 * 1000)
            : null;

          const data = await getHeatmapData({
            siteId: page.site_id,
            pageUrl: page.page_url,
            deviceType: "desktop",
            heatmapType: "click",
            startDate: startDate?.toISOString().slice(0, 10),
            endDate: endDate.toISOString().slice(0, 10),
          });

          const key = `heatmap:v2:${page.site_id}:${page.page_url}:desktop:click:${range.label}`;
          await redis.setex(key, 6 * 3600, JSON.stringify(data));

          warmed++;
        }
      }

      return { warmed, pages: popularPages.length };
    });
  }
);


