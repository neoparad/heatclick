# 表示問題の修正内容

**修正日**: 2025年1月26日

---

## 🐛 報告された問題

### 問題①: ヒートマップのビジュアルデータが表示されない

**原因**:
1. ヒートマップインスタンスのクリーンアップが不十分
2. コンテナのサイズが確定する前に描画を試みている
3. 無効な座標データが含まれている可能性
4. エラーハンドリングが不十分

**修正内容**:
- ✅ ヒートマップインスタンスのクリーンアップを改善
- ✅ 描画前に100msの遅延を追加（コンテナサイズ確定を待つ）
- ✅ 有効な座標データのみをフィルタリング
- ✅ エラーハンドリングとログ出力を追加
- ✅ データ取得時のエラーメッセージを追加

### 問題②: ダッシュボードがいきなり全てリセットされている

**原因**:
1. `dateRange`のデフォルトが`'30days'`で、過去30日間のデータしか表示されない
2. サイトが選択されていない場合の処理が不十分
3. エラー時の状態リセットが不適切

**修正内容**:
- ✅ `dateRange`のデフォルトを`'all'`（全期間）に変更
- ✅ サイトが選択されていない場合の処理を追加
- ✅ エラー時の状態リセットを改善
- ✅ エラーメッセージのクリアを追加

### 問題③: リアルタイムページが何も表示されていない

**原因**:
1. サイトが選択されていない場合の処理が不十分
2. APIエラーのハンドリングが不十分
3. エラー時の状態リセットが不適切
4. ログ出力が不十分

**修正内容**:
- ✅ サイトが選択されていない場合の処理を追加
- ✅ APIエラーのハンドリングを改善
- ✅ エラー時の状態リセットを追加
- ✅ ログ出力を追加（デバッグ用）

---

## 📋 修正ファイル一覧

### 1. `app/heatmap/page.tsx`

**修正内容**:
- ヒートマップ描画ロジックの改善
- データ取得時のエラーハンドリング改善

**変更箇所**:

```typescript
// ヒートマップ描画の改善
useEffect(() => {
  if (!h337 || !heatmapContainerRef.current || heatmapData.length === 0) {
    // データがない場合は既存のキャンバスをクリーンアップ
    if (heatmapContainerRef.current) {
      const canvas = heatmapContainerRef.current.querySelector('canvas')
      if (canvas) {
        canvas.remove()
      }
    }
    return
  }

  // 少し遅延させてコンテナのサイズが確定してから描画
  const timer = setTimeout(() => {
    // 有効な座標データのみをフィルタリング
    const points = heatmapData
      .filter(point => 
        typeof point.click_x === 'number' && 
        typeof point.click_y === 'number' &&
        !isNaN(point.click_x) && 
        !isNaN(point.click_y) &&
        point.click_x >= 0 && 
        point.click_y >= 0
      )
      .map(point => ({
        x: Math.round(point.click_x),
        y: Math.round(point.click_y),
        value: point.count || point.click_count || 1,
      }))
    
    // データを設定
    heatmapInstance.setData({
      max: maxValue,
      data: points,
    })
  }, 100)
  
  return () => {
    clearTimeout(timer)
    // クリーンアップ処理
  }
}, [heatmapData])
```

### 2. `app/dashboard/page.tsx`

**修正内容**:
- デフォルト期間を`'all'`に変更
- サイト選択時の処理を改善
- エラーハンドリングを改善

**変更箇所**:

```typescript
// デフォルト期間を変更
const [dateRange, setDateRange] = useState<'all' | '7days' | '30days' | '90days'>('all')

// サイト選択時の処理を改善
useEffect(() => {
  if (!selectedSite) {
    setStatistics(null)
    return
  }

  const fetchStatistics = async () => {
    try {
      setError(null) // エラーメッセージをクリア
      // ... 統計データ取得処理
    } catch (err) {
      console.error('Error fetching statistics:', err)
      setError('統計情報の取得に失敗しました')
      setStatistics(null) // エラー時は統計をリセット
    }
  }

  fetchStatistics()
}, [selectedSite, dateRange])
```

### 3. `app/realtime/page.tsx`

**修正内容**:
- サイト選択時の処理を改善
- APIエラーハンドリングを改善
- ログ出力を追加

**変更箇所**:

```typescript
// サイト選択時の処理を改善
const fetchData = async () => {
  if (!selectedSite) {
    setEvents([])
    setStats({
      totalEvents: 0,
      uniqueUsers: 0,
      uniqueSessions: 0,
      clicks: 0,
      scrolls: 0,
      pageViews: 0
    })
    return
  }
  
  setIsLoading(true)
  try {
    const response = await fetch(`/api/track?siteId=${selectedSite}&limit=50`)
    if (!response.ok) {
      throw new Error(`Failed to fetch events: ${response.status} ${response.statusText}`)
    }
    const result = await response.json()
    const eventData = result.data || []
    console.log('Fetched events:', eventData.length, 'events')
    setEvents(eventData)
    // ... 統計計算
  } catch (error) {
    console.error('Failed to fetch data:', error)
    setEvents([])
    setStats({
      totalEvents: 0,
      uniqueUsers: 0,
      uniqueSessions: 0,
      clicks: 0,
      scrolls: 0,
      pageViews: 0
    })
  } finally {
    setIsLoading(false)
  }
}
```

---

## ✅ 修正後の動作

### ヒートマップページ

- ✅ ヒートマップが正しく表示される
- ✅ 無効な座標データがフィルタリングされる
- ✅ エラーメッセージが表示される
- ✅ デバッグログが出力される

### ダッシュボード

- ✅ デフォルトで全期間のデータが表示される
- ✅ サイトが選択されていない場合の処理が適切
- ✅ エラー時の状態リセットが適切
- ✅ エラーメッセージがクリアされる

### リアルタイムページ

- ✅ サイトが選択されていない場合の処理が適切
- ✅ APIエラーが適切にハンドリングされる
- ✅ エラー時の状態リセットが適切
- ✅ デバッグログが出力される

---

## 🔍 技術的な詳細

### ヒートマップ描画の改善

1. **遅延描画**: コンテナのサイズが確定するまで100ms待機
2. **データ検証**: 有効な座標データのみをフィルタリング
3. **クリーンアップ**: タイマーとインスタンスの適切なクリーンアップ

### ダッシュボードの改善

1. **デフォルト期間**: `'all'`に変更して全データを表示
2. **状態管理**: サイト選択時の状態リセットを追加
3. **エラーハンドリング**: エラー時の適切な状態リセット

### リアルタイムページの改善

1. **初期状態**: サイトが選択されていない場合の処理を追加
2. **エラーハンドリング**: APIエラー時の適切な処理
3. **ログ出力**: デバッグ用のログを追加

---

## 📝 確認方法

### ヒートマップページ

1. `/heatmap`にアクセス
2. サイトとページを選択
3. ブラウザのコンソールでログを確認
4. ヒートマップが表示されることを確認

### ダッシュボード

1. `/dashboard`にアクセス
2. 全期間のデータが表示されることを確認
3. 期間を変更してデータが更新されることを確認
4. エラーメッセージが適切に表示されることを確認

### リアルタイムページ

1. `/realtime`にアクセス
2. サイトを選択
3. ブラウザのコンソールでログを確認
4. イベントが表示されることを確認

---

**最終更新**: 2025年1月26日

