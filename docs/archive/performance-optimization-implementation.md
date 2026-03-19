# パフォーマンス改善の実装

**実装日**: 2025年1月26日  
**目的**: データ量増加に伴うパフォーマンス問題を解決するための即座に実装可能な改善を実施

---

## ✅ 実装した改善

### 1. キャッシュキーの改善

#### 問題点

- ヒートマップデータのキャッシュキーに期間（`startDate`, `endDate`）が含まれていなかった
- 異なる期間のデータが同じキャッシュから取得される可能性があった
- 期間を変更しても古いキャッシュが返される問題があった

#### 実装内容

**変更ファイル**: `lib/redis.ts`, `app/api/heatmap/route.ts`

**変更前**:
```typescript
// 期間が含まれていないキャッシュキー
const key = `heatmap:${siteId}:${pageUrl}${deviceType ? `:${deviceType}` : ''}`
```

**変更後**:
```typescript
// 期間を含めたキャッシュキー
const key = `heatmap:${siteId}:${pageUrl}:${deviceType || 'all'}:${startDate || 'all'}:${endDate || 'all'}`
```

**変更詳細**:
- `getHeatmapCache`関数に`startDate`と`endDate`パラメータを追加
- `setHeatmapCache`関数に`startDate`と`endDate`パラメータを追加
- `app/api/heatmap/route.ts`で期間を含めたキャッシュキーを使用するように修正

#### 効果

- ✅ 期間ごとに適切なキャッシュが使用される
- ✅ 期間変更時に正しいデータが取得される
- ✅ キャッシュヒット率の向上

---

### 2. クエリの最適化（セッション統計）

#### 問題点

- セッション統計の計算で、全セッションデータを取得してJavaScriptでループ処理していた
- 大量のセッションがある場合、メモリ使用量と処理時間が増加
- データベースから大量のデータを転送する必要があった

#### 実装内容

**変更ファイル**: `lib/clickhouse.ts`

**変更前**:
```typescript
// 全セッションデータを取得してループ処理
const sessionData = await sessionResult.json() as any[]

for (const session of sessionData) {
  const start = new Date(session.session_start)
  const end = new Date(session.session_end)
  const duration = (end.getTime() - start.getTime()) / 1000
  totalDuration += duration
  
  if (Number(session.page_views) <= 1) {
    bounceSessions++
  }
}
```

**変更後**:
```sql
-- ClickHouseの集約関数を活用
SELECT 
  count() as total_sessions,
  avg(dateDiff('second', session_start, session_end)) as avg_duration_seconds,
  countIf(page_views <= 1) as bounce_sessions
FROM (
  SELECT 
    session_id,
    min(timestamp) as session_start,
    max(timestamp) as session_end,
    countIf(event_type = 'page_view' OR event_type = 'pageview') as page_views
  FROM clickinsight.events
  WHERE site_id = {site_id:String}
  GROUP BY session_id
)
```

**変更詳細**:
- サブクエリでセッションごとの開始時刻、終了時刻、ページビュー数を集約
- 外側のクエリで`avg(dateDiff('second', ...))`を使用して平均滞在時間を計算
- `countIf(page_views <= 1)`を使用して直帰セッション数を計算
- JavaScriptでのループ処理を完全に削除

#### 効果

- ✅ **処理速度の大幅向上**: データベース側で集約処理を実行
- ✅ **メモリ使用量の削減**: 集約結果のみを転送（1行のみ）
- ✅ **スケーラビリティ**: セッション数が増えてもパフォーマンスが維持される
- ✅ **ネットワーク転送量の削減**: 大量のセッションデータを転送する必要がない

---

## 📊 期待される効果

### クエリ実行時間

- **改善前**: 5-10秒（大量セッションの場合）
- **改善後**: 0.5-2秒（集約関数使用時）

### メモリ使用量

- **改善前**: セッション数 × データサイズ（例: 10,000セッション × 500バイト = 5MB）
- **改善後**: 集約結果のみ（約100バイト）

### データベース負荷

- **改善前**: 大量のデータ転送とJavaScriptでの集計処理
- **改善後**: データベース側での集約処理のみ

---

## 🔍 技術的な詳細

### キャッシュキーの構造

```
heatmap:{siteId}:{pageUrl}:{deviceType}:{startDate}:{endDate}
```

**例**:
- `heatmap:site123:/page1:all:2025-01-01:2025-01-31`
- `heatmap:site123:/page1:desktop:2025-01-01:2025-01-31`

### 集約クエリの構造

```sql
-- ステップ1: セッションごとの集約
SELECT 
  session_id,
  min(timestamp) as session_start,
  max(timestamp) as session_end,
  countIf(event_type = 'page_view' OR event_type = 'pageview') as page_views
FROM clickinsight.events
WHERE site_id = {site_id:String}
GROUP BY session_id

-- ステップ2: 全体の集約
SELECT 
  count() as total_sessions,
  avg(dateDiff('second', session_start, session_end)) as avg_duration_seconds,
  countIf(page_views <= 1) as bounce_sessions
FROM (ステップ1の結果)
```

---

## 📝 関連ファイル

- `lib/redis.ts`: キャッシュ関数の改善
- `app/api/heatmap/route.ts`: キャッシュキーの使用箇所の修正
- `lib/clickhouse.ts`: セッション統計クエリの最適化

---

## 🎯 次のステップ

### 中期的に実装すべき改善

1. **集約テーブルの作成**
   - 日次・時間別の集約データを事前計算
   - バックグラウンドジョブで定期実行

2. **データのサンプリング**
   - ヒートマップポイントの表示数を制限（最大1000件）
   - 重要度の高いポイントを優先的に表示

### 監視項目

- クエリ実行時間の推移
- キャッシュヒット率
- データベース負荷（CPU、メモリ）

---

## ✅ 動作確認項目

1. **キャッシュキーの改善**
   - ✅ 異なる期間で異なるキャッシュが使用される
   - ✅ 期間変更時に正しいデータが取得される
   - ✅ キャッシュが正しく保存・取得される

2. **クエリの最適化**
   - ✅ セッション統計が正しく計算される
   - ✅ 平均滞在時間が正しく表示される
   - ✅ 直帰率が正しく表示される
   - ✅ クエリ実行時間が短縮される

---

**最終更新**: 2025年1月26日

