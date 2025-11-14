# ClickInsight Pro - 実装完了サマリー

最終更新: 2025年1月25日

## 📊 プロジェクト概要

**プロジェクト名**: ClickInsight Pro  
**コンセプト**: 「SEO × UX × AI Insight」— 検索意図と行動データを統合する"知能型ヒートマップ分析"  
**開発フェーズ**: Phase 1完了 / Phase 2進行中  
**本番環境**: Vercel（稼働中）

---

## ✅ Phase 1: 基盤完成（完了）

### 1. データベース統合 ✅

#### ClickHouse接続
- [x] ClickHouseクライアント実装（`lib/clickhouse.ts`）
- [x] 遅延初期化パターン実装
- [x] 環境変数からの動的設定対応

#### データベーススキーマ

**eventsテーブル**（拡張版：収益・広告連携対応）
```sql
CREATE TABLE clickinsight.events (
  id String,
  site_id String,
  session_id String,
  user_id Nullable(String),
  event_type String,
  timestamp DateTime,
  url String,
  referrer Nullable(String),
  user_agent String,
  viewport_width UInt16,
  viewport_height UInt16,
  element_tag_name Nullable(String),
  element_id Nullable(String),
  element_class_name Nullable(String),
  element_text Nullable(String),
  element_href Nullable(String),
  click_x UInt16,
  click_y UInt16,
  scroll_y UInt16,
  scroll_percentage UInt8,
  event_revenue Decimal(10, 2) DEFAULT 0,
  utm_source Nullable(String),
  utm_medium Nullable(String),
  utm_campaign Nullable(String),
  utm_term Nullable(String),
  utm_content Nullable(String),
  gclid Nullable(String),
  fbclid Nullable(String),
  conversion_type Nullable(String),
  conversion_value Decimal(10, 2) DEFAULT 0,
  search_query Nullable(String),
  device_type Nullable(String),
  received_at DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (site_id, timestamp)
PARTITION BY toYYYYMM(timestamp);
```

**sessionsテーブル**（セッション集約）
```sql
CREATE TABLE clickinsight.sessions (
  session_id String,
  site_id String,
  user_id Nullable(String),
  start_time DateTime,
  end_time DateTime,
  duration UInt32,
  page_views UInt16,
  events_count UInt32,
  total_revenue Decimal(10, 2) DEFAULT 0,
  conversion_type Nullable(String),
  landing_page String,
  exit_page String,
  utm_source Nullable(String),
  utm_medium Nullable(String),
  utm_campaign Nullable(String),
  search_query Nullable(String),
  device_type Nullable(String),
  referrer_type Nullable(String)
) ENGINE = MergeTree()
ORDER BY (site_id, start_time)
PARTITION BY toYYYYMM(start_time);
```

**session_recordingsテーブル**（セッション録画）
```sql
CREATE TABLE clickinsight.session_recordings (
  id String,
  site_id String,
  session_id String,
  user_id Nullable(String),
  start_time DateTime,
  end_time DateTime,
  duration UInt32,
  events_count UInt32,
  recording_data String,
  metadata String,
  has_conversion UInt8 DEFAULT 0,
  conversion_value Decimal(10, 2) DEFAULT 0,
  created_at DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (site_id, session_id, start_time)
PARTITION BY toYYYYMM(start_time);
```

**gsc_dataテーブル**（Google Search Consoleデータ）
```sql
CREATE TABLE clickinsight.gsc_data (
  site_id String,
  date Date,
  query String,
  page String,
  clicks UInt32,
  impressions UInt32,
  ctr Float32,
  position Float32,
  device String,
  created_at DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (site_id, date, query, page)
PARTITION BY toYYYYMM(date);
```

**heatmap_summaryテーブル**（集計済みヒートマップキャッシュ）
```sql
CREATE TABLE clickinsight.heatmap_summary (
  site_id String,
  page_url String,
  date Date,
  device_type String,
  click_data String,
  scroll_data String,
  click_count UInt32,
  scroll_depth_avg Float32,
  last_updated DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(last_updated)
ORDER BY (site_id, page_url, date, device_type)
PARTITION BY toYYYYMM(date);
```

**usersテーブル**（マルチテナント対応）
```sql
CREATE TABLE clickinsight.users (
  id String,
  email String,
  password String,
  name String,
  plan String DEFAULT 'free',
  status String DEFAULT 'active',
  org_id Nullable(String),
  role String DEFAULT 'user',
  created_at DateTime,
  updated_at DateTime
) ENGINE = MergeTree()
ORDER BY (id);
```

**sitesテーブル**（マルチテナント対応）
```sql
CREATE TABLE clickinsight.sites (
  id String,
  name String,
  url String,
  tracking_id String,
  status String,
  user_id Nullable(String),
  org_id Nullable(String),
  created_at DateTime,
  updated_at DateTime,
  last_activity DateTime,
  page_views UInt64
) ENGINE = MergeTree()
ORDER BY (id);
```

### 2. Redis統合 ✅

- [x] Redisクライアント実装（`lib/redis.ts`）
- [x] キャッシュ機能（ヒートマップ、統計データ）
- [x] Pub/Sub実装（リアルタイム通知）
- [x] エラーハンドリングとフォールバック

### 3. トラッキングシステム ✅

#### トラッキングスクリプト（`public/tracking.js`）
- [x] クリック、スクロール、ページビュー追跡
- [x] バッチ送信（`navigator.sendBeacon`対応）
- [x] UTMパラメータ・広告ID自動取得
- [x] デバイスタイプ・リファラータイプ自動判定
- [x] オプトアウト・Cookie同意チェック
- [x] セッション管理
- [x] 軽量化（5KB以下目標）

#### 録画スクリプト（`public/recording.js`）
- [x] rrwebライブラリ統合（CDN経由）
- [x] セッション録画機能
- [x] プライバシー対応（入力フィールドマスキング）
- [x] サンプリングレート設定
- [x] バッチ送信

#### API Routes
- [x] `/api/track` - トラッキングデータ受信（バッチ対応）
- [x] `/api/events` - イベントデータ受信
- [x] `/api/recordings` - 録画データ受信・取得
- [x] `/api/recordings/[id]` - 特定録画データ取得

### 4. 認証システム ✅

- [x] NextAuth.js基盤
- [x] ユーザー登録機能（`app/auth/register/page.tsx`）
- [x] ログイン機能（`app/auth/login/page.tsx`）
- [x] セッション管理（localStorageベース）
- [x] パスワードハッシュ化（bcryptjs）
- [x] AuthGuardコンポーネント（`components/layout/AuthGuard.tsx`）

### 5. セッション録画機能 ✅

- [x] rrwebライブラリインストール
- [x] 録画スクリプト実装
- [x] 録画データ保存API
- [x] 録画再生UI（`app/recordings/page.tsx`）
- [x] サイドバーに録画ページ追加
- [x] コンバージョンセッションの優先表示

### 6. プライバシー・GDPR対応 ✅

- [x] IP匿名化機能（`lib/privacy.ts`）
- [x] ユーザーエージェント簡略化
- [x] オプトアウト設定
- [x] Cookie同意API対応
- [x] トラッキングスクリプトへの統合

### 7. セッション集約・ファネル分析 ✅

- [x] セッション集約機能（`lib/session-aggregator.ts`）
- [x] ファネル分析API（`app/api/funnel/route.ts`）
- [x] ページ遷移パターン集計

### 8. Google Search Console連携 ✅

- [x] GSC API連携基盤（`lib/integrations/gsc.ts`）
- [x] GSCデータ保存API（`app/api/gsc/route.ts`）
- [x] クエリごとのヒートマップAPI（`app/api/heatmap/query/route.ts`）
- [x] ヒートマップページにクエリフィルター機能追加
- [x] GSC CTR / 平均順位 × ヒートマップ統合

### 9. 外部API連携基盤 ✅

- [x] GA4 API連携基盤（`lib/integrations/ga4.ts`）
- [x] Shopify API連携基盤（`lib/integrations/shopify.ts`）
- [x] Google Ads API連携基盤（`lib/integrations/google-ads.ts`）
- [x] Meta Ads API連携基盤（`lib/integrations/meta-ads.ts`）

---

## 🚀 Phase 2: 差別化機能（進行中）

### 1. AI インサイト（RAG + ML統合）

#### 実装状況
- [x] Claude API連携UI（完成済み）
- [ ] MLモデル学習パイプライン
- [ ] RAGシステム構築
- [ ] AI提案生成UI

#### 詳細仕様
詳細は `docs/complete-specification.md` の「2.1 AI インサイト（RAG + ML統合）」を参照

### 2. SEO × UX 統合分析 ✅

- [x] Google Search Console API連携
- [x] GSC CTR / 平均順位 × ヒートマップ統合
- [ ] 「SEO×UX解析」ダッシュボード（UI実装待ち）

### 3. 広告別 ROI ヒートマップ

- [x] Google Ads API連携基盤
- [x] Meta Ads API連携基盤
- [ ] 広告別ROIヒートマップ表示（UI実装待ち）

---

## 📁 実装済みファイル一覧

### フロントエンド

#### ページ
- `app/page.tsx` - ランディングページ
- `app/dashboard/page.tsx` - ダッシュボード
- `app/realtime/page.tsx` - リアルタイムページ
- `app/heatmap/page.tsx` - ヒートマップページ（クエリフィルター機能含む）
- `app/clicks/page.tsx` - クリック分析ページ
- `app/recordings/page.tsx` - セッション録画ページ（新規）
- `app/ai-insights/page.tsx` - AI分析ページ
- `app/reports/page.tsx` - レポートページ
- `app/settings/page.tsx` - 設定ページ
- `app/sites/page.tsx` - サイト管理ページ
- `app/install/page.tsx` - インストールページ
- `app/auth/login/page.tsx` - ログインページ
- `app/auth/register/page.tsx` - 登録ページ

#### レイアウトコンポーネント
- `components/layout/DashboardLayout.tsx` - ダッシュボードレイアウト
- `components/layout/Sidebar.tsx` - サイドバー（録画ページ追加）
- `components/layout/Header.tsx` - ヘッダー（ログアウト機能含む）
- `components/layout/Footer.tsx` - フッター
- `components/layout/AuthGuard.tsx` - 認証ガード

#### UIコンポーネント
- `components/ui/button.tsx`
- `components/ui/card.tsx`
- `components/ui/input.tsx`
- `components/ui/label.tsx`
- `components/ui/select.tsx`
- `components/ui/badge.tsx`
- `components/ui/loading.tsx` - ローディング表示
- `components/ui/error-message.tsx` - エラーメッセージ

### バックエンドAPI

#### トラッキング・イベント
- `app/api/track/route.ts` - トラッキングデータ受信（収益・広告連携対応、IP匿名化）
- `app/api/events/route.ts` - イベントデータ受信
- `app/api/recordings/route.ts` - 録画データ受信・取得（新規）
- `app/api/recordings/[id]/route.ts` - 特定録画データ取得（新規）

#### サイト管理
- `app/api/sites/route.ts` - サイト管理API（GET, POST）
- `app/api/sites/[id]/route.ts` - サイト個別API（GET, PUT, DELETE）

#### 分析・統計
- `app/api/heatmap/route.ts` - ヒートマップデータ取得
- `app/api/heatmap/query/route.ts` - クエリごとのヒートマップ取得（新規）
- `app/api/statistics/route.ts` - 統計データ取得
- `app/api/funnel/route.ts` - ファネル分析API

#### 外部API連携
- `app/api/gsc/route.ts` - Google Search Consoleデータ取得・保存（新規）
- `app/api/install/route.ts` - インストールコード生成API

#### 認証
- `app/api/auth/login/route.ts` - ログインAPI
- `app/api/auth/register/route.ts` - 登録API

#### その他
- `app/api/health/route.ts` - ヘルスチェックAPI

### ライブラリ・ユーティリティ

#### データベース
- `lib/clickhouse.ts` - ClickHouseクライアント（全テーブルスキーマ含む）
- `lib/redis.ts` - Redisクライアント（キャッシュ、Pub/Sub）

#### 外部API連携
- `lib/integrations/gsc.ts` - Google Search Console API連携（新規）
- `lib/integrations/ga4.ts` - GA4 API連携基盤
- `lib/integrations/shopify.ts` - Shopify API連携基盤
- `lib/integrations/google-ads.ts` - Google Ads API連携基盤
- `lib/integrations/meta-ads.ts` - Meta Ads API連携基盤

#### 機能モジュール
- `lib/auth.ts` - 認証機能（登録、ログイン、セッション管理）
- `lib/session-aggregator.ts` - セッション集約・ファネル分析
- `lib/privacy.ts` - プライバシー・GDPR対応
- `lib/rate-limit.ts` - レート制限

#### ユーティリティ
- `lib/utils.ts` - 汎用ユーティリティ関数

### トラッキングスクリプト

- `public/tracking.js` - メイントラッキングスクリプト（UTM・広告ID取得、デバイス判定含む）
- `public/recording.js` - セッション録画スクリプト（新規）
- `public/track.js` - 旧トラッキングスクリプト（互換性のため保持）

### ドキュメント

- `docs/complete-specification.md` - 完全仕様書（RAG + ML統合詳細含む）
- `docs/differentiation-specification.md` - 差別化設計書
- `docs/project-status.md` - プロジェクト状況
- `docs/current-specification.md` - 現在の仕様書
- `docs/implementation-summary.md` - 本ドキュメント

---

## 🔧 環境変数設定

### 必須環境変数

```env
# アプリケーション設定
NEXT_PUBLIC_APP_URL=https://your-domain.vercel.app
NODE_ENV=production

# データベース設定
CLICKHOUSE_URL=http://default:PASSWORD@SERVER_IP:8123/clickinsight
# または個別設定
CLICKHOUSE_HOST=SERVER_IP
CLICKHOUSE_PORT=8123
CLICKHOUSE_DATABASE=clickinsight
CLICKHOUSE_USERNAME=default
CLICKHOUSE_PASSWORD=YOUR_PASSWORD

# Redis設定
REDIS_URL=redis://:PASSWORD@SERVER_IP:6379
# または個別設定
REDIS_HOST=SERVER_IP
REDIS_PORT=6379
REDIS_PASSWORD=YOUR_PASSWORD

# 認証設定
NEXTAUTH_SECRET=your-secret-key
NEXTAUTH_URL=https://your-domain.vercel.app
```

### 外部API連携（オプション）

```env
# Google Search Console API
GSC_CLIENT_EMAIL=your-service-account-email@project-id.iam.gserviceaccount.com
GSC_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nYour Private Key\n-----END PRIVATE KEY-----
GSC_SITE_URL=sc-domain:example.com

# Claude API（AI分析用）
CLAUDE_API_KEY=your-claude-api-key

# GA4 API（収益データ連携用）
GA4_PROPERTY_ID=your-property-id
GA4_CLIENT_EMAIL=your-service-account-email
GA4_PRIVATE_KEY=your-private-key

# Shopify API（収益データ連携用）
SHOPIFY_SHOP_DOMAIN=your-shop.myshopify.com
SHOPIFY_ACCESS_TOKEN=your-access-token

# Google Ads API（広告連携用）
GOOGLE_ADS_CUSTOMER_ID=your-customer-id
GOOGLE_ADS_DEVELOPER_TOKEN=your-developer-token
GOOGLE_ADS_CLIENT_ID=your-client-id
GOOGLE_ADS_CLIENT_SECRET=your-client-secret
GOOGLE_ADS_REFRESH_TOKEN=your-refresh-token

# Meta Ads API（広告連携用）
META_ADS_ACCESS_TOKEN=your-access-token
META_ADS_AD_ACCOUNT_ID=your-ad-account-id
```

---

## 📊 API仕様

### トラッキングAPI

#### POST `/api/track`
**説明**: トラッキングデータを受信

**リクエストボディ**:
```json
{
  "events": [
    {
      "id": "event-id",
      "site_id": "site-id",
      "session_id": "session-id",
      "user_id": "user-id",
      "event_type": "click",
      "timestamp": "2025-01-25T12:00:00Z",
      "url": "https://example.com/page",
      "click_x": 100,
      "click_y": 200,
      "utm_source": "google",
      "utm_medium": "cpc",
      "gclid": "gclid-value",
      "device_type": "desktop"
    }
  ]
}
```

**レスポンス**:
```json
{
  "success": true,
  "received": 1
}
```

### 録画API

#### POST `/api/recordings`
**説明**: 録画データを受信

**リクエストボディ**:
```json
{
  "site_id": "site-id",
  "session_id": "session-id",
  "user_id": "user-id",
  "events": [...rrweb events...],
  "is_final": false,
  "timestamp": "2025-01-25T12:00:00Z"
}
```

#### GET `/api/recordings`
**説明**: 録画一覧を取得

**クエリパラメータ**:
- `siteId` (必須)
- `sessionId` (オプション)
- `limit` (デフォルト: 50)

#### GET `/api/recordings/[id]`
**説明**: 特定の録画データを取得（再生用）

### GSC API

#### POST `/api/gsc`
**説明**: GSCデータを取得して保存

**リクエストボディ**:
```json
{
  "siteId": "site-id",
  "startDate": "2025-01-01",
  "endDate": "2025-01-25",
  "action": "save"
}
```

#### GET `/api/gsc`
**説明**: 保存済みGSCデータを取得

**クエリパラメータ**:
- `siteId` (必須)
- `startDate` (オプション)
- `endDate` (オプション)
- `query` (オプション)
- `page` (オプション)

### クエリごとのヒートマップAPI

#### GET `/api/heatmap/query`
**説明**: クエリごとのヒートマップデータを取得

**クエリパラメータ**:
- `siteId` (必須)
- `query` (必須) - 検索クエリ
- `pageUrl` (オプション)
- `startDate` (オプション)
- `endDate` (オプション)

**レスポンス**:
```json
{
  "success": true,
  "query": "検索クエリ",
  "heatmapData": [
    {
      "click_x": 100,
      "click_y": 200,
      "click_count": 50,
      "url": "https://example.com/page"
    }
  ],
  "gscData": {
    "query": "検索クエリ",
    "page": "https://example.com/page",
    "total_clicks": 1000,
    "total_impressions": 5000,
    "avg_ctr": 0.2,
    "avg_position": 3.5
  },
  "pages": ["https://example.com/page"]
}
```

---

## 🎯 主要機能

### 1. ヒートマップ分析
- クリックヒートマップ
- スクロールヒートマップ
- クエリごとのヒートマップ（GSC連携）
- デバイス別ヒートマップ
- 流入元別ヒートマップ

### 2. セッション録画
- セッション録画（rrweb使用）
- 録画再生機能
- コンバージョンセッションの優先表示
- プライバシー対応（入力フィールドマスキング）

### 3. ファネル分析
- セッションごとのページ遷移
- 離脱ポイント分析
- ページ遷移パターン集計

### 4. リアルタイム分析
- リアルタイムイベント監視
- Redis Pub/Subによる通知
- 統計情報のリアルタイム更新

### 5. 認証・ユーザー管理
- ユーザー登録・ログイン
- セッション管理
- マルチテナント対応（org_id）

### 6. プライバシー・GDPR対応
- IP匿名化
- オプトアウト機能
- Cookie同意管理
- ユーザーエージェント簡略化

---

## 📈 次のステップ

### Phase 2: 差別化機能（優先度: 高）

1. **AI インサイト実装**
   - [ ] MLモデル学習パイプライン
   - [ ] RAGシステム構築
   - [ ] AI提案生成UI

2. **SEO × UX 統合分析**
   - [x] GSC連携（完了）
   - [ ] 「SEO×UX解析」ダッシュボードUI

3. **広告別 ROI ヒートマップ**
   - [x] API連携基盤（完了）
   - [ ] UI実装

### Phase 3: 上位拡張（優先度: 中）

1. **ファネル分析UI**
   - [x] バックエンド実装（完了）
   - [ ] Graph View / Sankey Diagram可視化

2. **キャッシュ設計最適化**
   - [x] テーブル作成（完了）
   - [ ] 集計処理実装

3. **レポート自動生成**
   - [ ] AIレポートテンプレート
   - [ ] 週次/月次自動生成
   - [ ] メール配信

4. **A/Bテスト連携**
   - [ ] variant_id付きイベント記録
   - [ ] ヒートマップ比較表示

---

## 🔗 関連ドキュメント

- [完全仕様書](./complete-specification.md) - 詳細仕様とAI機能の設計
- [差別化設計書](./differentiation-specification.md) - Heatmap.comとの比較
- [プロジェクト状況](./project-status.md) - 最新の開発状況
- [現在の仕様書](./current-specification.md) - 基本仕様

---

## 📝 更新履歴

- **2025-01-25**: 実装完了サマリー作成
  - Phase 1完了項目の記録
  - GSC連携実装完了
  - セッション録画機能実装完了
  - 実装済みファイル一覧
  - API仕様
  - 環境変数設定









