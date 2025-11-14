# ヒートマップ閲覧パフォーマンス問題 - AI相談用仕様書

**作成日**: 2025年1月26日  
**問題の種類**: パフォーマンス・タイムアウト  
**優先度**: 🔴 高（緊急）

---

## 📋 問題の概要

### 現状の問題

1. **ヒートマップページの読み込みが非常に重い**
   - ページを開いてからヒートマップが表示されるまで時間がかかる
   - ブラウザがフリーズするような状態になることがある

2. **APIリクエストがタイムアウトする**
   - `/api/heatmap`エンドポイントが60秒以内に応答を返せず、タイムアウトエラーが発生
   - 特に「全期間」を選択した場合に発生しやすい

3. **ユーザー体験の悪化**
   - データが表示されるまで長時間待つ必要がある
   - タイムアウトが発生すると、エラーメッセージが表示されるだけでデータが見られない

---

## 🏗️ システム構成

### アーキテクチャ

```
フロントエンド (Next.js)
  ↓ HTTP GET
APIエンドポイント (/api/heatmap)
  ↓
Redis キャッシュ (オプション)
  ↓
ClickHouse データベース
  ↓
events テーブル / heatmap_events テーブル
```

### 技術スタック

- **フロントエンド**: Next.js 14 (App Router), React, TypeScript
- **バックエンド**: Next.js API Routes
- **データベース**: ClickHouse
- **キャッシュ**: Redis (ioredis)
- **デプロイ**: Vercel (Hobbyプラン)
- **ヒートマップライブラリ**: heatmap.js

---

## 📊 データベーススキーマ

### eventsテーブル（クリックヒートマップ用）

```sql
CREATE TABLE clickinsight.events (
  id String,
  site_id String,
  session_id String,
  event_type String, -- 'click', 'scroll', 'pageview' など
  timestamp DateTime,
  url String,
  click_x UInt16,
  click_y UInt16,
  element_tag_name Nullable(String),
  element_id Nullable(String),
  element_class_name Nullable(String),
  device_type Nullable(String),
  -- その他のフィールド...
) ENGINE = MergeTree()
ORDER BY (site_id, timestamp)
PARTITION BY toYYYYMM(timestamp);
```

### heatmap_eventsテーブル（スクロール・熟読ヒートマップ用）

```sql
CREATE TABLE clickinsight.heatmap_events (
  id String,
  session_id String,
  page_url String,
  event_type String, -- 'scroll', 'read', 'click'
  x UInt16,
  y UInt16,
  value Float32,
  created_at DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (page_url, event_type, y)
PARTITION BY toYYYYMM(created_at);
```

### データ量の目安

- **1サイトあたり**: 数万〜数百万イベント（期間による）
- **1ページあたり**: 数千〜数十万クリックイベント
- **全期間選択時**: 最大で数百万行をスキャンする可能性

---

## 🔍 現在の実装詳細

### 1. APIエンドポイント (`app/api/heatmap/route.ts`)

```typescript
export const maxDuration = 60 // 60秒のタイムアウト

export async function GET(request: NextRequest) {
  // 1. Redisキャッシュから取得を試みる
  heatmapData = await getHeatmapCache(...)
  
  // 2. キャッシュがない場合、ClickHouseから取得
  if (!heatmapData || heatmapData.length === 0) {
    heatmapData = await getHeatmapData(
      siteId,
      pageUrl,
      deviceType,
      startDate,
      endDate,
      heatmapType
    )
    
    // 3. キャッシュに保存
    await setHeatmapCache(...)
  }
  
  return NextResponse.json({ success: true, data: heatmapData })
}
```

### 2. ClickHouseクエリ (`lib/clickhouse.ts`)

#### クリックヒートマップのクエリ

```sql
SELECT
  click_x,
  click_y,
  count() as click_count,
  max(timestamp) as last_click,
  argMax(element_tag_name, timestamp) as element_tag_name,
  argMax(element_id, timestamp) as element_id,
  argMax(element_class_name, timestamp) as element_class_name
FROM clickinsight.events
WHERE site_id = {site_id:String}
  AND url = {page_url:String}
  AND event_type = 'click'
  -- 期間フィルター（オプション）
  AND timestamp >= {start_date:String}  -- 全期間選択時はなし
  AND timestamp <= {end_date:String}    -- 全期間選択時はなし
GROUP BY click_x, click_y
ORDER BY click_count DESC
LIMIT 10000
```

**問題点**:
- 全期間選択時、数百万行をスキャンする可能性
- `GROUP BY click_x, click_y` で大量のデータを集約
- `LIMIT 10000` でも、GROUP BYの処理が重い

#### スクロール深度ヒートマップのクエリ

```sql
-- 1. 各Y座標ごとの統計を取得
SELECT 
  y as scroll_y,
  count() as session_count,
  uniq(session_id) as unique_sessions,
  avg(value) as avg_scroll_percentage,
  max(value) as max_scroll_percentage
FROM clickinsight.heatmap_events
WHERE page_url = {page_url:String}
  AND event_type = 'scroll'
  -- 期間フィルター
GROUP BY y
ORDER BY scroll_y ASC

-- 2. 全セッション数を取得（別クエリ）
SELECT uniq(session_id) as total_sessions
FROM clickinsight.heatmap_events
WHERE page_url = {page_url:String}
  AND event_type = 'scroll'
```

**問題点**:
- 2つのクエリを実行している（非効率）
- 全期間選択時、大量のデータをスキャン

### 3. フロントエンド (`app/heatmap/page.tsx`)

```typescript
// ヒートマップデータを取得
useEffect(() => {
  const fetchHeatmap = async () => {
    const response = await fetch(`/api/heatmap?${params}`)
    const data = await response.json()
    setHeatmapData(data.data || []) // 最大10,000ポイント
  }
  fetchHeatmap()
}, [selectedSite, selectedPageUrl, dateRange, heatmapType])

// ヒートマップを描画
useEffect(() => {
  const points = heatmapData.map(point => ({
    x: point.click_x,
    y: point.click_y,
    value: point.count || point.click_count || 1,
  }))
  
  heatmapInstance.setData({
    max: maxValue,
    data: points, // 最大10,000ポイントを一度に描画
  })
}, [heatmapData])
```

**問題点**:
- 最大10,000ポイントを一度に描画しようとしている
- フロントエンドでのデータ処理が重い

### 4. キャッシュ (`lib/redis.ts`)

```typescript
// キャッシュキー（heatmap_typeが含まれていない！）
const key = `heatmap:${siteId}:${pageUrl}:${deviceType || 'all'}:${startDate || 'all'}:${endDate || 'all'}`

// TTL: 1時間
const CACHE_TTL = {
  HEATMAP: 3600,
}
```

**問題点**:
- キャッシュキーに`heatmap_type`が含まれていない
- クリック、スクロール、熟読のキャッシュが混在する可能性
- Redis接続が失敗している場合、キャッシュが効かない

---

## 🎯 解決すべき課題

### 課題1: ClickHouseクエリの最適化

**現状**:
- 全期間選択時、数百万行をスキャン
- GROUP BY処理が重い
- タイムアウトが発生

**目標**:
- クエリ実行時間を10秒以内に短縮
- データ量が多い場合でもタイムアウトしない

**検討事項**:
1. **インデックスの最適化**
   - `(site_id, url, event_type, timestamp)` の複合インデックス
   - パーティションの活用

2. **サンプリング**
   - データ量が多い場合、ランダムサンプリング
   - または、重要度の高いポイントのみ取得

3. **集約テーブルの活用**
   - `heatmap_summary`テーブルに事前集計データを保存
   - 日次バッチジョブで集計

4. **LIMITの最適化**
   - 10,000件は多すぎる可能性
   - フロントエンドで表示可能な件数に制限（例: 1,000件）

### 課題2: キャッシュ戦略の改善

**現状**:
- キャッシュキーに`heatmap_type`が含まれていない
- Redis接続が失敗している可能性
- キャッシュヒット率が低い

**目標**:
- キャッシュヒット率を80%以上に向上
- 初回アクセス後、2回目以降は即座に表示

**検討事項**:
1. **キャッシュキーの修正**
   ```typescript
   const key = `heatmap:${siteId}:${pageUrl}:${deviceType || 'all'}:${heatmapType}:${startDate || 'all'}:${endDate || 'all'}`
   ```

2. **キャッシュTTLの調整**
   - 全期間: 24時間（データが変わりにくい）
   - 期間指定: 1時間（データが変わりやすい）

3. **Redis接続の確認**
   - Redis接続が正常に動作しているか確認
   - 接続失敗時のフォールバック戦略

4. **キャッシュウォーミング**
   - バックグラウンドジョブで人気ページのキャッシュを事前生成

### 課題3: フロントエンドの最適化

**現状**:
- 最大10,000ポイントを一度に描画
- データ取得から描画まで時間がかかる

**目標**:
- 初回表示を3秒以内に
- スムーズな描画

**検討事項**:
1. **データポイントの制限**
   - サーバー側で1,000件に制限
   - 重要度の高いポイントを優先

2. **段階的読み込み**
   - まず重要なポイント（クリック数の多い順）を表示
   - 残りをバックグラウンドで読み込み

3. **仮想化**
   - 表示領域内のポイントのみ描画
   - スクロール時に動的に読み込み

4. **Web Worker**
   - データ処理をWeb Workerで実行
   - メインスレッドのブロックを防止

### 課題4: APIタイムアウトの対応

**現状**:
- 60秒のタイムアウトでもタイムアウトが発生
- Vercel Hobbyプランの制限

**目標**:
- タイムアウトを発生させない
- または、タイムアウト時の適切なエラーハンドリング

**検討事項**:
1. **非同期処理**
   - 長時間かかるクエリは非同期で実行
   - ジョブIDを返し、ポーリングで結果を取得

2. **ストリーミング**
   - Server-Sent Events (SSE) で段階的にデータを送信
   - フロントエンドで受信しながら描画

3. **バックグラウンドジョブ**
   - Vercel Cron Jobsで事前集計
   - 集計済みデータを返す

4. **タイムアウト時間の調整**
   - Vercel Proプランにアップグレード（300秒）
   - または、クエリを最適化して60秒以内に収める

---

## 📈 パフォーマンス目標

### 目標値

| 指標 | 現状 | 目標 |
|------|------|------|
| API応答時間（キャッシュあり） | - | < 100ms |
| API応答時間（キャッシュなし、期間指定） | タイムアウト | < 5秒 |
| API応答時間（キャッシュなし、全期間） | タイムアウト | < 10秒 |
| フロントエンド描画時間 | 10秒以上 | < 3秒 |
| キャッシュヒット率 | 不明 | > 80% |
| タイムアウト発生率 | 高 | 0% |

---

## 🔧 実装の制約

### 技術的制約

1. **Vercel Hobbyプラン**
   - 関数のタイムアウト: 10秒（Hobby）または60秒（Pro）
   - 現在の設定: 60秒（Pro相当？）

2. **ClickHouse**
   - 既存のスキーマを変更する場合は慎重に
   - パーティション戦略は既に実装済み

3. **Redis**
   - 接続が失敗している可能性
   - モック実装にフォールバックしている

4. **フロントエンド**
   - heatmap.jsライブラリの制約
   - 大量のポイントを一度に描画する必要がある

### ビジネス制約

1. **既存機能の維持**
   - 現在の機能を損なわない
   - 後方互換性の維持

2. **開発リソース**
   - 最小限の変更で最大の効果
   - 段階的な改善

---

## 📝 実装の優先順位

### Phase 1: 緊急対応（即座に実施）

1. **キャッシュキーの修正**
   - `heatmap_type`をキャッシュキーに追加
   - 実装時間: 30分

2. **LIMITの削減**
   - 10,000件 → 1,000件に削減
   - 実装時間: 15分

3. **エラーハンドリングの改善**
   - タイムアウト時の適切なエラーメッセージ
   - 実装時間: 30分

### Phase 2: 短期対応（1週間以内）

1. **集約テーブルの活用**
   - `heatmap_summary`テーブルに事前集計
   - バックグラウンドジョブで更新
   - 実装時間: 2-3日

2. **インデックスの最適化**
   - 複合インデックスの追加
   - 実装時間: 1日

3. **フロントエンドの最適化**
   - データポイントの制限
   - 段階的読み込み
   - 実装時間: 2-3日

### Phase 3: 中期対応（1ヶ月以内）

1. **非同期処理の実装**
   - 長時間クエリの非同期化
   - ジョブ管理システム
   - 実装時間: 1週間

2. **ストリーミング対応**
   - SSEの実装
   - 段階的なデータ送信
   - 実装時間: 1週間

---

## 🧪 テスト方法

### パフォーマンステスト

1. **API応答時間の測定**
   ```bash
   # 期間指定
   time curl "http://localhost:3000/api/heatmap?site_id=xxx&page_url=xxx&start_date=2025-01-01&end_date=2025-01-26"
   
   # 全期間
   time curl "http://localhost:3000/api/heatmap?site_id=xxx&page_url=xxx"
   ```

2. **キャッシュヒット率の測定**
   - 同じリクエストを2回実行
   - 2回目の応答時間が100ms以下か確認

3. **フロントエンド描画時間の測定**
   - Chrome DevToolsのPerformanceタブで測定
   - データ取得から描画完了まで

### 負荷テスト

1. **大量データでのテスト**
   - 100万イベント以上のデータでテスト
   - タイムアウトが発生しないか確認

2. **同時アクセステスト**
   - 複数のユーザーが同時にアクセス
   - サーバーの負荷を確認

---

## 📚 関連ドキュメント

- `docs/performance-optimization-proposal.md` - パフォーマンス改善提案
- `docs/performance-optimization-implementation.md` - パフォーマンス改善実装
- `docs/heatmap-types-status.md` - ヒートマップタイプの実装状況

---

## ❓ AIへの質問

1. **ClickHouseクエリの最適化方法**
   - 数百万行をスキャンするクエリを10秒以内に実行する方法
   - インデックス戦略の提案
   - サンプリング戦略の提案

2. **キャッシュ戦略の最適化**
   - Redisキャッシュの効果的な活用方法
   - キャッシュキーの設計
   - キャッシュウォーミングの実装方法

3. **フロントエンドの最適化**
   - 大量のデータポイントを効率的に描画する方法
   - 段階的読み込みの実装方法
   - Web Workerの活用方法

4. **タイムアウト対策**
   - Vercel環境でのタイムアウト対策
   - 非同期処理の実装方法
   - ストリーミングの実装方法

5. **アーキテクチャの改善**
   - より効率的なアーキテクチャの提案
   - 集約テーブルの活用方法
   - バックグラウンドジョブの実装方法

---

**最終更新**: 2025年1月26日


