# ClickInsight Pro - システムアーキテクチャ

最終更新: 2025年1月26日

## 🏗️ 全体アーキテクチャ

### システム構成図

```
┌─────────────────────────────────────────────────────────┐
│                  フロントエンド層                          │
│  Next.js 14 (App Router) + React 18 + TypeScript       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │ダッシュ  │  │リアルタイム│  │ヒートマップ│            │
│  │ボード    │  │アラート    │  │表示      │            │
│  └──────────┘  └──────────┘  └──────────┘            │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│                    API層（Next.js API Routes）           │
│  - 認証/認可  - レート制限  - キャッシング               │
│  - /api/track  - /api/sites  - /api/heatmap 等          │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│                  データ統合層                              │
│  ┌─────────────────────────────────────────────┐       │
│  │  リアルタイム処理（Redis Pub/Sub）          │       │
│  │  - イベント集約  - セッション管理           │       │
│  └─────────────────────────────────────────────┘       │
│  ┌─────────────────────────────────────────────┐       │
│  │  バッチ処理（Inngest / スケジュール）       │       │
│  │  - データクレンジング  - 集計               │       │
│  └─────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│                  AI分析層                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │RAGシステム│  │MLモデル群│  │外部API連携│            │
│  │          │  │          │  │          │            │
│  │- 知識検索│  │- 予測    │  │- GSC     │            │
│  │- 事例提示│  │- 分類    │  │- GA4     │            │
│  │- 提案生成│  │- 異常検知│  │- Ads API │            │
│  └──────────┘  └──────────┘  └──────────┘            │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│                  データストレージ層                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │ClickHouse│  │  Redis   │  │  (将来)  │            │
│  │          │  │          │  │PostgreSQL│            │
│  │- events  │  │- キャッシュ│  │- ユーザー│            │
│  │- sites   │  │- Pub/Sub │  │- 認証    │            │
│  │- sessions│  │          │  │          │            │
│  └──────────┘  └──────────┘  └──────────┘            │
└─────────────────────────────────────────────────────────┘
```

## 📊 データフロー

### イベント収集フロー

```
1. トラッキングスクリプト（クライアント）
   ↓
2. バッチ送信（sendBeacon / fetch）
   ↓
3. API Route (/api/track)
   ↓
4. Rate Limiting + IP匿名化
   ↓
5. ClickHouse挿入
   ├→ eventsテーブル（全イベント）
   ├→ heatmap_eventsテーブル（click/scroll/read）
   └→ image_visibilityテーブル（画像視認データ）
   ↓
6. Redis Pub/Sub（リアルタイム通知）
   ↓
7. 集計処理（バッチ/リアルタイム）
   ↓
8. heatmap_summaryテーブル更新
```

### 画像閲覧分析フロー

```
1. tracking.js: Intersection Observer で <img> 要素を監視
   - threshold: [0, 0.25, 0.5, 0.75, 1.0]
   - 表示時間(ms)・最大表示割合を計測
   ↓
2. ページ離脱時に image_visibility イベントを送信（上位30画像）
   ↓
3. /api/track → clickinsight.image_visibility テーブルに保存
   ↓
4. /api/image-visibility で集計
   - 画像ごとの平均視認時間・最大表示率・閲覧率
   - visibility_score (0-100) = avg_duration × avg_ratio を正規化
   ↓
5. ヒートマップページ「画像」タブで表示
   - ページプレビュー上にスコアバッジ + 枠線オーバーレイ
   - 画像別ランキングテーブル
   - クリックで詳細モーダル
```

### 収益データ連携フロー

```
1. GA4 / Shopify / Affiliate API
   ↓
2. バッチ処理（日次/時間次）
   ↓
3. セッションIDでマッチング
   ↓
4. eventsテーブルにevent_revenue更新
   ↓
5. sessionsテーブルに集計
```

### AI提案生成フロー

```
1. サイトデータ分析
   ↓
2. MLモデルで予測（コンバージョン、離脱、収益）
   ↓
3. 問題点の自動検出
   ↓
4. RAG検索（類似事例、ベストプラクティス）
   ↓
5. LLMで改善提案生成
   ↓
6. 優先度付け（ML予測スコア）
   ↓
7. 実装コード自動生成
   ↓
8. ai_suggestionsテーブルに保存
```

## 🔧 技術スタック詳細

### フロントエンド

#### Next.js 14 (App Router)
- **ルーティング**: App Routerベースのファイルシステムルーティング
- **レンダリング**: Server Components + Client Components
- **API Routes**: `/app/api` ディレクトリ内のルートハンドラー

#### 状態管理
- **React Hooks**: 基本の状態管理
- **Zustand**: 導入済みだが未使用（将来の拡張用）

#### UIライブラリ
- **shadcn/ui**: コンポーネントライブラリ
- **Tailwind CSS**: スタイリング
- **Lucide React**: アイコン

#### データ可視化
- **Recharts**: チャート表示
- **heatmap.js**: ヒートマップ表示
- **rrweb / rrweb-player**: セッション録画再生

### バックエンド

#### Next.js API Routes
- **ルートハンドラー**: `/app/api` ディレクトリ
- **ミドルウェア**: 認証、レート制限、CORS設定

#### データベース接続

##### ClickHouse
- **クライアント**: `@clickhouse/client`
- **接続管理**: 遅延初期化パターン（`lib/clickhouse.ts`）
- **設定**: 環境変数から動的設定
- **エラーハンドリング**: 接続エラー時のフォールバック

##### Redis
- **クライアント**: `ioredis`
- **接続管理**: 遅延初期化パターン（`lib/redis.ts`）
- **用途**: 
  - キャッシュ（ヒートマップデータ、統計データ）
  - Pub/Sub（リアルタイム通知）

#### 外部API連携
- **Google Search Console**: `lib/integrations/gsc.ts`
- **Google Analytics 4**: `lib/integrations/ga4.ts`
- **Google Ads**: `lib/integrations/google-ads.ts`
- **Meta Ads**: `lib/integrations/meta-ads.ts`
- **Shopify**: `lib/integrations/shopify.ts`
- **Claude API**: AI分析機能（未実装）

### インフラ

#### Vercel
- **フロントエンドホスティング**: Vercel Edge Network
- **API Routes**: Vercel Serverless Functions
- **環境変数**: Vercelダッシュボードで管理

#### Hetzner Cloud
- **データベースサーバー**: ClickHouse + Redis
- **セットアップ**: `scripts/setup-server.sh`
- **接続**: VercelからHetznerへの接続（環境変数で設定）

## 🗄️ データベース設計

### ClickHouse

#### データベース: `clickinsight`

#### 主要テーブル

1. **events** - イベントトラッキングデータ
   - パーティション: 月次（`toYYYYMM(timestamp)`）
   - ソートキー: `(site_id, timestamp)`

2. **sites** - サイト管理
   - ソートキー: `(id)`

3. **sessions** - セッション集約
   - パーティション: 月次（`toYYYYMM(start_time)`）
   - ソートキー: `(site_id, start_time)`

4. **heatmap_summary** - 集計済みヒートマップキャッシュ
   - パーティション: 月次（`toYYYYMM(date)`）
   - ソートキー: `(site_id, page_url, date)`

5. **users** - ユーザー管理（マルチテナント対応）
   - ソートキー: `(id)`

6. **gsc_data** - Google Search Consoleデータ
   - パーティション: 月次（`toYYYYMM(date)`）
   - ソートキー: `(site_id, date, query)`

7. **session_recordings** - セッション録画データ
   - パーティション: 月次（`toYYYYMM(start_time)`）
   - ソートキー: `(site_id, session_id, start_time)`

### Redis

#### キャッシュ戦略
- **ヒートマップデータ**: TTL 1時間
- **統計データ**: TTL 30分
- **セッションデータ**: TTL 24時間

#### Pub/Sub
- **チャンネル**: `realtime:events`
- **用途**: リアルタイムデータ通知

## 🔐 セキュリティ

### 認証・認可
- **現状**: 未実装
- **計画**: NextAuth.js v5（Auth.js）を使用

### データプライバシー
- **IP匿名化**: `lib/privacy.ts`で実装済み
- **Cookie同意**: オプトアウト機能実装済み
- **GDPR対応**: プライバシー機能実装済み

### API セキュリティ
- **CORS**: 設定済み
- **Rate Limiting**: 未実装（計画中）
- **入力検証**: Zodを使用

## 🚀 デプロイメント

### Vercel
- **ビルド**: Next.js自動ビルド
- **環境変数**: Vercelダッシュボードで管理
- **ドメイン**: 自動SSL証明書

### 環境変数

#### ClickHouse接続
```bash
CLICKHOUSE_URL=http://default:PASSWORD@SERVER_IP:8123/clickinsight
CLICKHOUSE_HOST=SERVER_IP
CLICKHOUSE_PORT=8123
CLICKHOUSE_DATABASE=clickinsight
CLICKHOUSE_USERNAME=default
CLICKHOUSE_PASSWORD=YOUR_PASSWORD
```

#### Redis接続
```bash
REDIS_URL=redis://:PASSWORD@SERVER_IP:6379
REDIS_HOST=SERVER_IP
REDIS_PORT=6379
REDIS_PASSWORD=YOUR_PASSWORD
```

#### 外部API
```bash
CLAUDE_API_KEY=your_claude_api_key
GSC_CLIENT_EMAIL=your_gsc_client_email
GSC_PRIVATE_KEY=your_gsc_private_key
```

## 📈 パフォーマンス最適化

### フロントエンド
- **コード分割**: Next.js自動コード分割
- **画像最適化**: Next.js Image最適化
- **キャッシング**: Vercel Edge Network

### バックエンド
- **データベース接続プール**: ClickHouse接続プール設定
- **キャッシング**: Redisキャッシュ戦略
- **バッチ処理**: イベントのバッチ送信

### トラッキングスクリプト
- **サイズ最適化**: 5KB以下目標
- **非同期送信**: `sendBeacon` / `fetch`使用
- **バッチ送信**: 複数イベントをまとめて送信

## 🔄 将来の拡張計画

### Phase 2: AI機能
- MLモデル学習パイプライン
- RAGシステム構築
- ベクトルデータベース統合

### Phase 3: スケーリング
- マイクロサービス化の検討
- メッセージキュー（BullMQ）の導入
- WebSocket（Socket.io）の導入

## 📝 更新履歴

- **2025-01-26**: ドキュメント整理 - ARCHITECTURE.md作成

