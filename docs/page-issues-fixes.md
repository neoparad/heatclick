# ページ表示問題の修正内容

**修正日**: 2025年1月26日  
**最終更新**: 2025年1月26日

---

## 🐛 報告された問題

### 問題①: ヒートマップページのクライアントサイドエラー

**エラーメッセージ**:
```
Application error: a client-side exception has occurred (see the browser console for more information).
```

**原因**:
1. `heatmap.js`の動的インポートが不適切
2. 空配列の場合の`maxValue`計算エラー
3. APIから返されるデータ構造とフロントエンドの期待が不一致

**修正内容**:
- ✅ `heatmap.js`の動的インポートを改善（エラーハンドリング追加）
- ✅ 空配列の場合の`maxValue`計算を修正
- ✅ データポイントの`count`と`click_count`の両方をサポート
- ✅ ヒートマップデータ取得クエリに要素情報を追加（`element_tag_name`, `element_id`, `element_class_name`）

### 問題②: リアルタイムページが表示されない

**原因**:
1. `event.eventType`が`undefined`になる可能性
2. APIから返されるデータのフィールド名が異なる（`eventType` vs `event_type`）
3. `getEventIcon`と`getEventColor`が`undefined`を処理していない

**修正内容**:
- ✅ `eventType`と`event_type`の両方をサポート
- ✅ `getEventIcon`と`getEventColor`に`undefined`チェックを追加
- ✅ イベントタイプの大文字小文字を正規化
- ✅ セッションID、URL、タイムスタンプのフォールバック処理を追加

### 問題③: ダッシュボードの統計表示問題

**問題点**:
1. 平均滞在時間と直帰率が表示されない
2. 総クリックの意味が不明確
3. クリック率の数字が正しいか不明
4. 平均スクロール深度が正しいか不明

**修正内容**:
- ✅ 平均滞在時間と直帰率の表示を改善（データがない場合のメッセージ追加）
- ✅ 総クリック数の説明を追加（「全クリックイベントの合計」）
- ✅ クリック率の説明を追加（「セッションあたりの平均クリック数（総クリック数/セッション数×100）」）
- ✅ 平均スクロール深度の説明を追加（「ページビューあたりの平均スクロール位置（0-100%）」）
- ✅ 平均スクロール深度の範囲チェックを追加（0-100%に制限）
- ✅ 数値の型変換を明示的に行う（`Number()`を使用）

---

## 📋 修正ファイル一覧

### 1. `app/heatmap/page.tsx`

**修正内容**:
- `heatmap.js`の動的インポートを改善
- 空配列の場合のエラーハンドリング
- データ構造の不一致を修正

**変更箇所**:
```typescript
// 修正前
const h337 = typeof window !== 'undefined' ? require('heatmap.js') : null

// 修正後
let h337: any = null
if (typeof window !== 'undefined') {
  try {
    h337 = require('heatmap.js')
  } catch (error) {
    console.error('Failed to load heatmap.js:', error)
  }
}
```

### 2. `app/realtime/page.tsx`

**修正内容**:
- イベントタイプの取得を改善
- `undefined`チェックを追加
- データフィールドのフォールバック処理

**変更箇所**:
```typescript
// 修正前
const EventIcon = getEventIcon(event.eventType)

// 修正後
const eventType = event.eventType || event.event_type || 'unknown'
const EventIcon = getEventIcon(eventType)
```

### 3. `app/dashboard/page.tsx`

**修正内容**:
- KPIデータの計算を改善
- 説明文を追加
- データがない場合の表示を改善

**変更箇所**:
```typescript
// 修正前
clickRate: statistics.unique_sessions > 0 ? ((statistics.clicks / statistics.unique_sessions) * 100).toFixed(1) : '0',

// 修正後
clickRate: statistics.unique_sessions > 0 
  ? ((Number(statistics.clicks) / Number(statistics.unique_sessions)) * 100).toFixed(1) 
  : '0',
```

### 4. `lib/clickhouse.ts`

**修正内容**:
- ヒートマップデータ取得クエリに要素情報を追加

**変更箇所**:
```sql
-- 修正前
SELECT
  click_x,
  click_y,
  count() as click_count,
  max(timestamp) as last_click

-- 修正後
SELECT
  click_x,
  click_y,
  count() as click_count,
  max(timestamp) as last_click,
  argMax(element_tag_name, timestamp) as element_tag_name,
  argMax(element_id, timestamp) as element_id,
  argMax(element_class_name, timestamp) as element_class_name
```

---

## ✅ 修正後の動作

### ヒートマップページ

- ✅ クライアントサイドエラーが解消
- ✅ ヒートマップが正しく表示される
- ✅ 要素情報が表示される

### リアルタイムページ

- ✅ イベントが正しく表示される
- ✅ イベントタイプが正しく識別される
- ✅ データがない場合のメッセージが表示される

### ダッシュボード

- ✅ 平均滞在時間と直帰率が表示される（データがある場合）
- ✅ データがない場合のメッセージが表示される
- ✅ 各指標の説明が追加された
- ✅ クリック率の計算が明確になった
- ✅ 平均スクロール深度の範囲が正しく制限される

---

## 📊 指標の説明

### 総クリック数
- **意味**: 全クリックイベントの合計
- **計算**: `countIf(event_type = 'click')`

### クリック率
- **意味**: セッションあたりの平均クリック数
- **計算**: `(総クリック数 / ユニークセッション数) × 100`
- **例**: 100クリック、10セッション → 1000%（セッションあたり10クリック）

### 平均滞在時間
- **意味**: セッションあたりの平均滞在時間
- **計算**: `avg(duration)` from `clickinsight.sessions`
- **単位**: 分

### 直帰率
- **意味**: 1ページビューのセッション割合
- **計算**: `(1ページビューのセッション数 / 全セッション数) × 100`
- **単位**: %

### 平均スクロール深度
- **意味**: ページビューあたりの平均スクロール位置
- **計算**: `avg(scroll_percentage)` from `clickinsight.events`
- **範囲**: 0-100%

---

## 🔍 確認方法

### ヒートマップページ

1. `/heatmap`にアクセス
2. サイトとページを選択
3. ヒートマップが表示されることを確認
4. ブラウザのコンソールでエラーがないことを確認

### リアルタイムページ

1. `/realtime`にアクセス
2. サイトを選択
3. イベントが表示されることを確認
4. イベントタイプが正しく表示されることを確認

### ダッシュボード

1. `/dashboard`にアクセス
2. サイトを選択
3. 各指標が正しく表示されることを確認
4. 説明文が表示されることを確認

---

## 📝 関連ドキュメント

- [ダッシュボード改善内容](./dashboard-improvements.md) - 期間表示とアクセス数の追加

---

**最終更新**: 2025年1月26日

