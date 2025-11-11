# ClickInsight Pro - 現在の仕様書

最終更新: 2025年1月25日

## 📋 プロジェクト概要

**プロジェクト名**: ClickInsight Pro
**説明**: AI搭載のヒートマップ・クリック分析ツール
**開発フェーズ**: MVP開発完了 / 機能拡張段階
**技術スタック**: Next.js 14, React 18, TypeScript, Tailwind CSS, shadcn/ui

## 🏗️ アーキテクチャ

### フロントエンド
- **フレームワーク**: Next.js 14 (App Router)
- **UI**: React 18 + TypeScript
- **スタイリング**: Tailwind CSS + shadcn/ui
- **状態管理**: React Hooks (将来Zustand導入予定)
- **チャート**: Recharts
- **ヒートマップ**: heatmap.js

### バックエンド
- **API**: Next.js API Routes
- **データベース**: ClickHouse (予定) / 現在はメモリ内ストレージ
- **キャッシュ**: Redis (予定)
- **外部API**: Google Search Console, Google Ads, Claude API

### インフラ
- **デプロイ**: Vercel
- **データベース**: ClickHouse (Hetzner Cloud)
- **キャッシュ**: Redis (Hetzner Cloud)
- **CDN**: Vercel Edge Network

## 📱 実装済みページ

### 1. ダッシュボード (`/dashboard`)
**機能**:
- KPIカード表示（総クリック数、クリック率、平均滞在時間、直帰率）
- トップクリック要素ランキング
- 検索クエリ別パフォーマンス
- サンプルデータ表示

**技術実装**:
- レスポンシブデザイン
- リアルタイムデータ更新
- インタラクティブなチャート

### 2. リアルタイム (`/realtime`)
**機能**:
- ライブデータ監視
- 統計情報表示（総イベント数、ユニークユーザー、セッション数、クリック数）
- イベント履歴表示
- トラッキングスクリプト情報

**技術実装**:
- 5秒間隔での自動更新
- イベントタイプ別フィルタリング
- リアルタイムデータ表示

### 3. ヒートマップ (`/heatmap`)
**機能**:
- ページ統計ダッシュボード
- 視覚的ヒートマップ表示
- 詳細クリックデータ
- AI改善提案機能
- 流入元・クエリ別分析

**技術実装**:
- 動的ヒートマップ生成
- クリック密度の可視化
- 改善提案の自動生成
- フィルタリング機能

### 4. サイト管理 (`/sites`)
**機能**:
- サイト登録・管理
- トラッキングコード生成
- GTM連携説明
- サイト一覧表示

**技術実装**:
- フォームバリデーション
- トラッキングコード自動生成
- コピー機能
- モーダル表示

### 5. クリック分析 (`/clicks`)
**機能**:
- 詳細クリックデータ分析
- フィルター機能（サイト、期間、ページ）
- ページ別・デバイス別分析
- エクスポート機能

**技術実装**:
- 高度なフィルタリング
- データ可視化
- エクスポート機能

### 6. AI分析 (`/ai-insights`)
**機能**:
- Claude Sonnet 4による自動分析
- 優先度別改善提案（緊急・重要・SEO）
- 実装コード自動生成
- 分析履歴管理

**技術実装**:
- AI分析結果の表示
- 実装コードの自動生成
- 分析履歴の管理

### 7. レポート (`/reports`)
**機能**:
- 複数レポートテンプレート
- 自動レポート生成
- 生成済みレポート管理
- 自動配信設定

**技術実装**:
- レポートテンプレートシステム
- 自動生成機能
- 配信スケジュール設定

### 8. 設定 (`/settings`)
**機能**:
- トラッキングスクリプト管理
- アカウント設定
- 通知設定
- データ管理

**技術実装**:
- 設定管理UI
- トラッキングスクリプト管理
- 通知設定

## 🔧 トラッキングシステム

### トラッキングスクリプト (`public/track.js`)
**機能**:
- クリック、スクロール、マウス移動、ページビューの追跡
- セッション管理とユーザー識別
- リアルタイムデータ送信
- エラーハンドリング

**技術実装**:
- 軽量JavaScript（5KB以下目標）
- 非同期データ送信
- セッション管理
- デバッグモード

### APIエンドポイント (`/api/track`)
**機能**:
- データ受信と保存
- データ取得機能
- エラーハンドリング

**技術実装**:
- RESTful API
- データバリデーション
- エラーレスポンス

## 🎨 UI/UX設計

### 共通レイアウト
- **サイドバー**: ナビゲーションメニュー
- **ヘッダー**: サイト選択、期間選択、アクションボタン
- **メインエリア**: コンテンツ表示
- **レスポンシブ**: モバイル・タブレット対応

### デザインシステム
- **カラーパレット**: ブルー系メイン、アクセントカラー
- **タイポグラフィ**: システムフォント
- **コンポーネント**: shadcn/uiベース
- **アイコン**: Lucide React

## 📊 データ構造

### クリックイベント
```typescript
interface ClickEvent {
  id: string
  siteId: string
  sessionId: string
  userId: string
  eventType: 'click' | 'scroll' | 'mouse_move' | 'page_view' | 'page_leave'
  timestamp: string
  url: string
  element?: {
    tagName: string
    id: string
    className: string
    text: string
    href?: string
  }
  position?: {
    x: number
    y: number
    relativeX: number
    relativeY: number
  }
}
```

### サイト情報
```typescript
interface Site {
  id: string
  name: string
  url: string
  trackingId: string
  status: 'active' | 'inactive' | 'pending'
  pageViews: number
  lastActivity: string
}
```

## 🚀 次のステップ

### 優先度: 高
1. **データベース統合**: ClickHouse + Redis
2. **外部API連携**: GSC, Google Ads, Claude API
3. **本番環境デプロイ**: Vercel

### 優先度: 中
1. **パフォーマンス最適化**
2. **セキュリティ強化**
3. **テストカバレッジ向上**

### 優先度: 低
1. **追加機能の実装**
2. **UI/UXの改善**
3. **ドキュメント整備**

## 📈 成功指標

### 技術指標
- ページ読み込み時間: < 2秒
- トラッキングスクリプトサイズ: < 5KB
- API応答時間: < 500ms
- データ精度: > 99%

### ビジネス指標
- ユーザー満足度: > 4.5/5
- 機能利用率: > 80%
- データ保持率: > 95%
- システム稼働率: > 99.9%





