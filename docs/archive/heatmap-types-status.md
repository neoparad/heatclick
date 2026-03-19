# ヒートマップタイプの実装状況

**確認日**: 2025年1月26日  
**目的**: 3種類のヒートマップタイプ（スクロール深度、熟読エリア、クリック）の実装状況を確認

---

## 📊 現在の実装状況

### ✅ 実装済み

1. **クリックヒートマップ**
   - ✅ データ取得: `/api/heatmap`エンドポイントでクリックデータを取得
   - ✅ 可視化: `heatmap.js`を使用してクリック位置を可視化
   - ✅ 表示: ヒートマップページで表示可能

### ❌ 未実装

2. **スクロール深度ヒートマップ**
   - ❌ データ取得: スクロール深度データの取得APIが未実装
   - ❌ 可視化: スクロール深度の可視化ロジックが未実装
   - ❌ 表示: ヒートマップページに切り替えUIが未実装

3. **熟読エリアヒートマップ**
   - ❌ データ取得: 熟読エリアデータの取得APIが未実装
   - ❌ 可視化: 熟読エリアの可視化ロジックが未実装
   - ❌ 表示: ヒートマップページに切り替えUIが未実装

---

## 🔍 現状の詳細

### 現在のヒートマップページ

- **ファイル**: `app/heatmap/page.tsx`
- **実装内容**: クリックヒートマップのみ
- **タイトル**: 「クリックヒートマップ」（固定）
- **データ取得**: `event_type = 'click'`のみ

### トラッキングスクリプト

- **ファイル**: `public/tracking.js`
- **実装状況**: 
  - ✅ スクロール深度のトラッキング（200ms間隔）
  - ✅ 熟読エリアのトラッキング（500ms停止検出）
  - ✅ クリックのトラッキング
- **データ送信**: `scroll`, `scroll_depth`, `read_area`イベントを送信

### データベース

- **テーブル**: `clickinsight.events`
- **フィールド**: 
  - ✅ `scroll_y`, `scroll_percentage`（スクロール深度用）
  - ✅ `read_y`, `read_duration`（熟読エリア用）
  - ✅ `click_x`, `click_y`（クリック用）
- **テーブル**: `clickinsight.heatmap_events`
  - ✅ スキーマ定義済み（`event_type`: 'scroll', 'read', 'click'）

---

## 🚧 実装が必要な機能

### 1. APIエンドポイントの追加

#### `/api/heatmap/scroll-depth`
```typescript
// スクロール深度データを取得
// 各Y座標ごとの到達率を計算
// 到達したセッション数 / 全セッション数
```

#### `/api/heatmap/read-area`
```typescript
// 熟読エリアデータを取得
// 各Y座標ごとの総滞在時間を合計
// 正規化して0-1のintensityに変換
```

#### `/api/heatmap/click`（既存）
```typescript
// クリックデータを取得（既存）
// クリック座標の密度マップ
```

### 2. ヒートマップページのUI更新

#### タブ切り替えUIの追加
```tsx
<Tabs>
  <TabsList>
    <TabsTrigger value="scroll">スクロール深度</TabsTrigger>
    <TabsTrigger value="read">熟読エリア</TabsTrigger>
    <TabsTrigger value="click">クリック</TabsTrigger>
  </TabsList>
  <TabsContent value="scroll">...</TabsContent>
  <TabsContent value="read">...</TabsContent>
  <TabsContent value="click">...</TabsContent>
</Tabs>
```

### 3. 可視化ロジックの実装

#### スクロール深度ヒートマップ
- ページ上部（赤）: 閲覧率100%
- 中間（黄）: 閲覧率50-99%
- 下部（青）: 閲覧率0-49%

#### 熟読エリアヒートマップ
- 視認時間が長いほど「赤」
- 低いほど「青」
- Gaussian blurで滑らかに

#### クリックヒートマップ（既存）
- クリック座標の密度マップ
- 既存の実装をそのまま使用

---

## 📝 実装ステップ

### Phase 1: データ取得APIの実装
1. `/api/heatmap/scroll-depth`エンドポイントを作成
2. `/api/heatmap/read-area`エンドポイントを作成
3. `lib/clickhouse.ts`に集計関数を追加

### Phase 2: UIの更新
1. ヒートマップページにタブ切り替えUIを追加
2. 各ヒートマップタイプの表示コンポーネントを作成
3. データ取得ロジックをタイプ別に分離

### Phase 3: 可視化の実装
1. スクロール深度の可視化ロジックを実装
2. 熟読エリアの可視化ロジックを実装
3. 各タイプの色設定とスタイルを調整

---

## 🎯 優先度

- **高**: クリックヒートマップは既に実装済み
- **中**: スクロール深度ヒートマップ（データは取得可能）
- **中**: 熟読エリアヒートマップ（データは取得可能）

---

---

## ✅ 実装状況の更新（2025年1月26日）

### バックエンド実装完了

1. **スクロール深度ヒートマップ**
   - ✅ データ取得関数: `lib/clickhouse.ts`の`getHeatmapData`関数に`heatmapType === 'scroll'`の処理を追加
   - ✅ APIエンドポイント: `/api/heatmap?heatmap_type=scroll`でデータ取得可能
   - ❌ フロントエンドUI: 未実装（次回実装予定）

2. **熟読エリアヒートマップ**
   - ✅ データ取得関数: `lib/clickhouse.ts`の`getHeatmapData`関数に`heatmapType === 'read'`の処理を追加
   - ✅ APIエンドポイント: `/api/heatmap?heatmap_type=read`でデータ取得可能
   - ❌ フロントエンドUI: 未実装（次回実装予定）

3. **クリックヒートマップ**
   - ✅ データ取得関数: 既存の実装を維持
   - ✅ APIエンドポイント: `/api/heatmap?heatmap_type=click`でデータ取得可能
   - ✅ フロントエンドUI: 実装済み

---

## 📚 関連ドキュメント

- [最新の変更内容まとめ](./latest-changes-2025-01-26.md) - 本日の実装内容の詳細

---

**最終更新**: 2025年1月26日

