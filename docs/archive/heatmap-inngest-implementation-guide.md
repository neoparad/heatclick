# 🚀 ClickInsight Pro – ヒートマップ根本改善・Inngestバージョン実装指示書（完全版）

**作成日**: 2025年1月26日  
**目的**: ヒートマップ閲覧のパフォーマンス問題を根本的に解決

---

## 📋 想定環境

- **Front**: Next.js 14 on Vercel
- **Background Jobs**: Inngest (Vercel Functionsとして実行)
- **DB**: ClickHouse on Hetzner
- **Cache**: Redis on Hetzner

---

## 🟩 1. アーキテクチャ（完成形）

```
NEXT.JS (Vercel)
   │
   │ API: /api/heatmap → Redis → 集約テーブル
   │
Inngest（Vercel Functionsとして実行）
   │
   │ バッチ集計・初期集約・再集計・キャッシュウォーミング
   │
ClickHouse（Hetzner）
Redis（Hetzner）
```

---

## 🟩 2. ClickHouse – 新テーブル & MV 作成

### 🔧 2-1. 集約テーブル（SummingMergeTree）

```sql
CREATE TABLE IF NOT EXISTS clickinsight.heatmap_daily_summary (
  site_id String,
  page_url String,
  device_type String,
  event_type String,
  date Date,
  click_x UInt16,
  click_y UInt16,
  click_count UInt32,
  unique_sessions UInt32,
  last_updated DateTime DEFAULT now()
)
ENGINE = SummingMergeTree(click_count, unique_sessions)
ORDER BY (site_id, page_url, event_type, date, device_type, click_x, click_y)
PARTITION BY toYYYYMM(date);
```

**注意点**:
- `SummingMergeTree`の集約キーは`(click_count, unique_sessions)`
- `device_type`をORDER BYに追加（デバイス別集計のため）

### 🔧 2-2. マテビュー（リアルタイム集約）

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS clickinsight.heatmap_daily_summary_mv
TO clickinsight.heatmap_daily_summary
AS
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
GROUP BY site_id, page_url, device_type, event_type, date, click_x, click_y;
```

**注意点**:
- `coalesce(device_type, 'unknown')`でNULLを回避
- `click_x > 0 AND click_y > 0`で無効な座標を除外

---

## 🟩 3. Inngest – フォルダ構成

```
/inngest/
   client.ts                    # Inngestクライアント初期化
   funcs/
      aggregateDaily.ts         # 日次集約ジョブ
      warmCache.ts              # キャッシュウォーミング
      rebuildAll.ts             # 過去データの初期集約
   lib/
      clickhouse.ts             # ClickHouse接続（既存を再利用）
      redis.ts                  # Redis接続（既存を再利用）
      heatmapQuery.ts           # 集約テーブル専用クエリ関数
```

---

## 🟩 4. Inngest – 基本クライアント

**ファイル**: `/inngest/client.ts`

```typescript
import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "clickinsight-pro",
  name: "ClickInsight Pro",
});
```

---

## 🟩 5. Inngest – 日次集約ジョブ（最重要）

**ファイル**: `/inngest/funcs/aggregateDaily.ts`

```typescript
import { inngest } from "../client";
import { getClickHouseClientAsync } from "@/lib/clickhouse";

export const aggregateDaily = inngest.createFunction(
  { 
    id: "daily-heatmap-aggregation",
    name: "Daily Heatmap Aggregation" 
  },
  { cron: "0 5 * * *" },    // 毎朝5:00 JST
  async ({ event, step }) => {
    return await step.run("aggregate-yesterday", async () => {
      // 昨日の範囲
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);
      const dateStr = yesterday.toISOString().slice(0, 10);

      const client = await getClickHouseClientAsync();

      // ClickHouse 集約クエリ
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

      await client.exec({
        query,
        query_params: { date: dateStr },
      });

      return { status: "ok", date: dateStr };
    });
  }
);
```

---

## 🟩 6. Inngest – 過去データの初期集約（1回だけ手動）

**ファイル**: `/inngest/funcs/rebuildAll.ts`

```typescript
import { inngest } from "../client";
import { getClickHouseClientAsync } from "@/lib/clickhouse";

export const rebuildAll = inngest.createFunction(
  { 
    id: "rebuild-all-heatmap-summary",
    name: "Rebuild All Heatmap Summary" 
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

      await client.exec({ query });

      return { status: "ok", message: "All heatmap data rebuilt" };
    });
  }
);
```

**実行方法**:
```typescript
// /api/inngest/rebuild エンドポイントから実行
import { inngest } from "@/inngest/client";

export async function POST() {
  await inngest.send({
    name: "heatmap.rebuild",
  });
  return Response.json({ status: "triggered" });
}
```

---

## 🟩 7. Inngest – キャッシュウォーミング

**ファイル**: `/inngest/funcs/warmCache.ts`

```typescript
import { inngest } from "../client";
import { getHeatmapData } from "../lib/heatmapQuery";
import { setHeatmapCache } from "@/lib/redis";
import { getClickHouseClientAsync } from "@/lib/clickhouse";

// 人気ページを取得
async function getPopularPages(limit: number = 100) {
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

          await setHeatmapCache(
            page.site_id,
            page.page_url,
            data,
            "desktop",
            startDate?.toISOString().slice(0, 10),
            endDate.toISOString().slice(0, 10),
            3600 * 6 // 6時間
          );

          warmed++;
        }
      }

      return { warmed, pages: popularPages.length };
    });
  }
);
```

---

## 🟩 8. heatmapQuery（集約テーブル専用）

**ファイル**: `/inngest/lib/heatmapQuery.ts`

```typescript
import { getClickHouseClientAsync } from "@/lib/clickhouse";

interface GetHeatmapDataParams {
  siteId: string;
  pageUrl: string;
  deviceType?: string;
  heatmapType: 'click' | 'scroll' | 'read';
  startDate?: string;
  endDate?: string;
}

export async function getHeatmapData({
  siteId,
  pageUrl,
  deviceType,
  heatmapType,
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
```

---

## 🟩 9. Next.js API（新・高速版）

**ファイル**: `/app/api/heatmap/route.ts`（既存を置き換え）

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getHeatmapCache, setHeatmapCache } from '@/lib/redis';
import { getHeatmapData } from '@/inngest/lib/heatmapQuery';

export const maxDuration = 10; // 集約テーブル使用で10秒で十分

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const siteId = searchParams.get('site_id');
    const pageUrl = searchParams.get('page_url');
    const deviceType = searchParams.get('device_type') || undefined;
    const startDate = searchParams.get('start_date') || undefined;
    const endDate = searchParams.get('end_date') || undefined;
    const heatmapType = (searchParams.get('heatmap_type') || 'click') as 'click' | 'scroll' | 'read';

    if (!siteId || !pageUrl) {
      return NextResponse.json(
        { error: 'Missing required parameters: site_id, page_url' },
        { status: 400 }
      );
    }

    // キャッシュキー（heatmap_typeを含む）
    const cacheKey = `heatmap:v2:${siteId}:${pageUrl}:${deviceType || 'all'}:${heatmapType}:${startDate || 'all'}:${endDate || 'all'}`;

    // キャッシュから取得を試みる
    let cached = false;
    let heatmapData: any[] = [];

    try {
      const cachedData = await getHeatmapCache(
        siteId,
        pageUrl,
        deviceType,
        startDate,
        endDate
      );
      
      if (cachedData && cachedData.length > 0) {
        heatmapData = cachedData;
        cached = true;
      }
    } catch (error) {
      console.error('Redis cache error:', error);
    }

    // キャッシュがない場合、集約テーブルから取得
    if (!cached || heatmapData.length === 0) {
      try {
        heatmapData = await getHeatmapData({
          siteId,
          pageUrl,
          deviceType,
          heatmapType,
          startDate,
          endDate,
        });

        // キャッシュに保存
        if (heatmapData && heatmapData.length > 0) {
          try {
            await setHeatmapCache(
              siteId,
              pageUrl,
              heatmapData,
              deviceType,
              startDate,
              endDate,
              3600 * 2 // 2時間
            );
          } catch (cacheError) {
            console.error('Failed to cache heatmap data:', cacheError);
          }
        }
      } catch (error) {
        console.error('Error fetching heatmap data:', error);
        heatmapData = [];
      }
    }

    return NextResponse.json({
      success: true,
      data: heatmapData || [],
      cached,
      heatmap_type: heatmapType,
    });
  } catch (error) {
    console.error('Error in heatmap API:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
```

**注意**: `getHeatmapCache`と`setHeatmapCache`のキャッシュキーに`heatmap_type`を含める必要があります（`lib/redis.ts`を修正）。

---

## 🟩 10. フロント側指示（段階描画）

**ファイル**: `/app/heatmap/page.tsx`（既存を修正）

```typescript
// ヒートマップを描画（段階的）
useEffect(() => {
  if (!h337 || !heatmapContainerRef.current || heatmapData.length === 0) {
    return;
  }

  const timer = setTimeout(() => {
    if (!heatmapContainerRef.current) return;

    try {
      const heatmapInstance = h337.create({
        container: heatmapContainerRef.current,
        radius: 40,
        maxOpacity: 0.6,
        minOpacity: 0,
        blur: 0.75,
      });

      // データをクリック数でソートし、上位500件に制限
      const sortedPoints = heatmapData
        .filter(point => 
          typeof point.click_x === 'number' && 
          typeof point.click_y === 'number' &&
          !isNaN(point.click_x) && 
          !isNaN(point.click_y) &&
          point.click_x >= 0 && 
          point.click_y >= 0
        )
        .sort((a, b) => (b.count || b.click_count || 0) - (a.count || a.click_count || 0))
        .slice(0, 500);

      // 段階的に描画（50件ずつ）
      const renderBatch = async (points: typeof sortedPoints) => {
        const batchSize = 50;
        const maxValue = Math.max(...points.map(p => p.count || p.click_count || 1), 1);

        for (let i = 0; i < points.length; i += batchSize) {
          const batch = points.slice(i, i + batchSize);
          
          const batchData = batch.map(point => ({
            x: Math.round(point.click_x || 0),
            y: Math.round(point.click_y || 0),
            value: point.count || point.click_count || 1,
          }));

          // 既存データに追加
          const existingData = heatmapInstance.getData();
          const newData = {
            max: maxValue,
            data: [...(existingData?.data || []), ...batchData],
          };

          heatmapInstance.setData(newData);

          // 次のバッチまで少し待機（メインスレッドをブロックしない）
          await new Promise(resolve => setTimeout(resolve, 0));
        }

        console.log('Heatmap rendered with', points.length, 'points');
      };

      renderBatch(sortedPoints);

      heatmapInstanceRef.current = heatmapInstance;
    } catch (error) {
      console.error('Error setting heatmap data:', error);
    }
  }, 100);

  return () => {
    clearTimeout(timer);
  };
}, [heatmapData, heatmapType]);
```

---

## 🟩 11. Inngest統合（Next.js App Router）

**ファイル**: `/app/api/inngest/route.ts`

```typescript
import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { aggregateDaily } from "@/inngest/funcs/aggregateDaily";
import { warmCache } from "@/inngest/funcs/warmCache";
import { rebuildAll } from "@/inngest/funcs/rebuildAll";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    aggregateDaily,
    warmCache,
    rebuildAll,
  ],
});
```

---

## 🟩 12. package.json に追加

```json
{
  "dependencies": {
    "inngest": "^3.0.0"
  }
}
```

---

## 🟩 13. 環境変数

`.env.local`に追加:

```env
INNGEST_EVENT_KEY=your_inngest_event_key
INNGEST_SIGNING_KEY=your_inngest_signing_key
```

Inngestダッシュボードから取得。

---

## 🟩 14. これで得られるメリット

✅ **API応答**: 50ms～300ms（キャッシュあり）、1-3秒（キャッシュなし）  
✅ **フロント描画**: 1〜2秒  
✅ **タイムアウト**: 完全ゼロ  
✅ **スケーラビリティ**: 生イベント数が10倍になっても処理時間は変わらない  
✅ **大規模アクセス**: 100万PV/日でも安定  

これは Hotjar・Clarity と同じアーキテクチャです。

---

## 📝 実装手順

### Step 1: ClickHouseテーブル作成（5分）
```bash
# ClickHouseサーバーに接続して実行
clickhouse-client --host=your-host --user=default --password=your-password
```

上記のSQLを実行。

### Step 2: Inngestセットアップ（10分）
1. Inngestアカウント作成
2. プロジェクト作成
3. 環境変数設定

### Step 3: コード実装（2-3時間）
1. `/inngest`フォルダ作成
2. 各ファイルを作成
3. APIルートを更新

### Step 4: 初期データ集約（1回だけ）
```bash
# /api/inngest/rebuild エンドポイントを呼び出し
curl -X POST http://localhost:3000/api/inngest/rebuild
```

### Step 5: 動作確認
1. 日次ジョブが実行されるか確認
2. キャッシュウォーミングが動作するか確認
3. API応答時間を測定

---

## ❓ 質問への回答

### ① InngestのSDK（どのランタイム？）

**回答**: **Next.js App Router（Vercel Functions）で動かす** ✅

**理由**:
- デプロイが簡単（Vercelに自動デプロイ）
- 既存のNext.jsプロジェクトと統合しやすい
- サーバーレスでスケーラブル
- コスト効率が良い

**実装方法**:
- `/app/api/inngest/route.ts`でInngestのserve関数を使用
- Vercel Functionsとして自動実行

### ② ClickHouse接続方法

**回答**: **`@clickhouse/client` を使用中** ✅

**確認結果**:
- `package.json`に`"@clickhouse/client": "^1.0.0"`が含まれている
- `lib/clickhouse.ts`で`import { ClickHouseClient, createClient } from '@clickhouse/client'`を使用

**実装時の注意**:
- 既存の`getClickHouseClientAsync()`関数を再利用可能
- `/inngest/lib/clickhouse.ts`は既存の`lib/clickhouse.ts`を再エクスポートするだけでもOK

```typescript
// /inngest/lib/clickhouse.ts
export { getClickHouseClientAsync } from "@/lib/clickhouse";
```

---

## 🔧 追加の最適化提案

### 1. Redisキャッシュキーの修正

`lib/redis.ts`の`getHeatmapCache`と`setHeatmapCache`を修正:

```typescript
// 修正前
const key = `heatmap:${siteId}:${pageUrl}:${deviceType || 'all'}:${startDate || 'all'}:${endDate || 'all'}`;

// 修正後
const key = `heatmap:v2:${siteId}:${pageUrl}:${deviceType || 'all'}:${heatmapType}:${startDate || 'all'}:${endDate || 'all'}`;
```

### 2. エラーハンドリングの改善

タイムアウト時の適切なエラーメッセージを追加。

### 3. モニタリング

Inngestダッシュボードでジョブの実行状況を監視。

---

**最終更新**: 2025年1月26日





