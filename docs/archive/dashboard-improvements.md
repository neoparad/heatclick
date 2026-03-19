# ダッシュボード改善内容

**更新日**: 2025年1月26日

---

## 📋 改善内容

### ① 期間表示の追加

**問題**: ダッシュボードに記載されている期間が分からない

**解決策**:
- ✅ 期間選択機能を追加（過去7日間、過去30日間、過去90日間、全期間）
- ✅ データ期間の表示を追加（最初のイベント日時 ～ 最後のイベント日時）
- ✅ 選択した期間の表示を追加

**実装内容**:
- 期間選択ドロップダウンを追加
- デフォルトは「過去30日間」
- データ期間を自動計算して表示
- 選択した期間と実際のデータ期間の両方を表示

### ② アクセス数の追加

**問題**: イベントだけでは不明なのでアクセス数も必要

**解決策**:
- ✅ ページビュー数を追加（アクセス数の指標）
- ✅ セッション数を追加（ユニークセッション数）
- ✅ KPIカードに「ページビュー数」と「セッション数」を追加

**実装内容**:
- `getStatistics`関数に`page_views`を追加
- `event_type = 'page_view' OR event_type = 'pageview'`でページビューをカウント
- セッション数は既存の`unique_sessions`を使用
- KPIカードのレイアウトを調整（6列 → 4列）

---

## 🔧 修正ファイル

### 1. `lib/clickhouse.ts`

**変更内容**:
- `getStatistics`関数のクエリに以下を追加:
  - `page_views`: ページビュー数のカウント
  - `first_event_time`: 最初のイベント日時
  - `last_event_time`: 最後のイベント日時

**変更箇所**:
```sql
-- 追加
countIf(event_type = 'page_view' OR event_type = 'pageview') as page_views,
min(timestamp) as first_event_time,
max(timestamp) as last_event_time
```

### 2. `app/dashboard/page.tsx`

**変更内容**:
1. **期間選択機能の追加**:
   - `dateRange`ステートを追加（'all' | '7days' | '30days' | '90days'）
   - 期間選択ドロップダウンを追加
   - 期間に基づいて`startDate`と`endDate`を計算
   - APIリクエストに期間パラメータを追加

2. **期間表示の追加**:
   - `getDateRangeText()`: 選択した期間の文字列を生成
   - `getDataPeriodText()`: 実際のデータ期間を表示
   - データ期間の表示を追加（カレンダーアイコン付き）

3. **アクセス数カードの追加**:
   - 「ページビュー数」カードを追加
   - 「セッション数」カードを追加
   - KPIカードのレイアウトを調整（6列 → 4列）

4. **Statisticsインターフェースの更新**:
   - `page_views?: number`を追加
   - `first_event_time?: string`を追加
   - `last_event_time?: string`を追加

---

## 📊 新しいKPIカード

### ページビュー数
- **表示**: ページビュー数の合計
- **説明**: アクセス数（ページビュー）
- **アイコン**: Eye（目）
- **色**: 青

### セッション数
- **表示**: ユニークセッション数
- **説明**: ユニークセッション数
- **アイコン**: Users（ユーザー）
- **色**: 緑

---

## 🎨 UI改善

### 期間選択セクション

```
┌─────────────────────────────────────┐
│ サイトを選択    │  期間を選択        │
│ [ドロップダウン] │ [ドロップダウン]   │
│                 │                   │
│ 📅 データ期間: 2025年1月1日 ～ 2025年1月26日 (過去30日間) │
└─────────────────────────────────────┘
```

### KPIカードレイアウト

**変更前**: 6列（総クリック数、クリック率、平均滞在時間、直帰率、平均スクロール深度、総イベント数）

**変更後**: 4列（ページビュー数、セッション数、総クリック数、クリック率、平均滞在時間、直帰率、平均スクロール深度、総イベント数）

---

## 📈 データ取得の改善

### 期間フィルタリング

- **過去7日間**: 今日から7日前まで
- **過去30日間**: 今日から30日前まで（デフォルト）
- **過去90日間**: 今日から90日前まで
- **全期間**: 期間制限なし

### データ期間の表示

- 実際のデータが存在する期間を表示
- 最初のイベント日時と最後のイベント日時を表示
- 選択した期間と実際のデータ期間の両方を表示

---

## ✅ 確認事項

### 期間表示
- [x] 期間選択ドロップダウンが表示される
- [x] 選択した期間が正しく表示される
- [x] データ期間が正しく表示される
- [x] 期間を変更するとデータが更新される

### アクセス数
- [x] ページビュー数が表示される
- [x] セッション数が表示される
- [x] 数値が正しくカウントされている
- [x] 説明文が適切に表示される

---

## 🔍 技術的な詳細

### 期間計算ロジック

```typescript
if (dateRange !== 'all') {
  const end = new Date()
  const start = new Date()
  
  switch (dateRange) {
    case '7days':
      start.setDate(start.getDate() - 7)
      break
    case '30days':
      start.setDate(start.getDate() - 30)
      break
    case '90days':
      start.setDate(start.getDate() - 90)
      break
  }
  
  startDate = start.toISOString().split('T')[0]
  endDate = end.toISOString().split('T')[0]
}
```

### ページビュー数のカウント

```sql
countIf(event_type = 'page_view' OR event_type = 'pageview') as page_views
```

- `page_view`と`pageview`の両方のイベントタイプをカウント
- 大文字小文字を区別しない（ClickHouseの仕様）

### データ期間の表示

```typescript
const getDataPeriodText = () => {
  if (!statistics || !statistics.first_event_time || !statistics.last_event_time) {
    return null
  }
  
  const firstDate = new Date(statistics.first_event_time)
  const lastDate = new Date(statistics.last_event_time)
  
  const formatDate = (date: Date) => {
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
  }
  
  if (firstDate.getTime() === lastDate.getTime()) {
    return formatDate(firstDate)
  }
  
  return `${formatDate(firstDate)} ～ ${formatDate(lastDate)}`
}
```

---

## 📝 今後の改善案

1. **カスタム期間選択**: 開始日と終了日を手動で選択できる機能
2. **期間比較**: 前週・前月との比較機能
3. **リアルタイム更新**: 期間選択時の自動更新
4. **エクスポート機能**: 選択した期間のデータをエクスポート
5. **グラフ表示**: 期間別のトレンドグラフ

---

**最終更新**: 2025年1月26日

