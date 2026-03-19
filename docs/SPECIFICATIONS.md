# ClickInsight Pro - 仕様書

最終更新: 2025年1月26日

## 📋 プロジェクト概要

**プロジェクト名**: ClickInsight Pro  
**コンセプト**: 「SEO × UX × AI Insight」— 検索意図と行動データを統合する"知能型ヒートマップ分析"  
**競合**: Heatmap.com（Revenue Visualization × CRO特化）  
**差別化ポイント**: 検索流入キーワード別のクリック熱量、売上に結びつく導線、AIによる改善提案

## 🎯 差別化コンセプト

### Heatmap.comとの比較

| 領域 | Heatmap.com | ClickInsight Pro |
|------|-------------|------------------|
| **強み** | Revenue Visualization × CRO特化 | SEO × UX × AI Insight統合 |
| **ターゲット** | Eコマースブランド | SEO特化型サイト、メディア、BtoB |
| **データソース** | 売上データ、広告連携 | 検索クエリ、GSC、GA4、行動データ |
| **分析軸** | Revenue per Click | 検索意図 × 行動パターン × コンバージョン |

### 独自ポジション

> **「検索意図と行動データを統合する"知能型ヒートマップ分析"」**

- 検索流入キーワード別のクリック熱量分析
- 売上に結びつく導線の可視化
- AIによる改善提案（SEO × UX統合）

## 🏗️ 技術スタック

### フロントエンド
- **フレームワーク**: Next.js 14 (App Router)
- **言語**: TypeScript
- **UIライブラリ**: React 18
- **スタイリング**: Tailwind CSS + shadcn/ui
- **状態管理**: React Hooks（Zustand導入済みだが未使用）
- **チャート**: Recharts
- **ヒートマップ**: heatmap.js
- **セッション録画**: rrweb / rrweb-player
- **アイコン**: Lucide React

### バックエンド
- **API**: Next.js API Routes
- **データベース**: ClickHouse（実装済みだが未接続、モック実装）
- **キャッシュ**: Redis（実装済みだが未接続、モック実装）
- **外部API**: 
  - Claude API（未連携、モックデータ使用）
  - Google Search Console API（基盤実装済み）
  - Google Ads API（基盤実装済み）
  - Google Analytics 4（基盤実装済み）
  - Meta Ads API（基盤実装済み）
  - Shopify API（基盤実装済み）

### インフラ
- **フロントエンドホスティング**: Vercel
- **データベースサーバー**: Hetzner Cloud（セットアップスクリプト準備済み）
- **データベース**: ClickHouse（Hetzner）
- **キャッシュ**: Redis（Hetzner）
- **CDN**: Vercel Edge Network

## 📱 機能仕様

### 1. ダッシュボード (`/dashboard`)
**実装状況**: ✅ 完了（サンプルデータ表示）

**機能**:
- KPIカード表示（総クリック数、クリック率、平均滞在時間、直帰率）
- トップクリック要素ランキング
- 検索クエリ別パフォーマンス
- チャート表示（Recharts）

**課題**:
- データがサンプルデータのみ
- ClickHouseから実際のデータを取得する必要がある

### 2. リアルタイムページ (`/realtime`)
**実装状況**: ✅ 完了（メモリ内データ）

**機能**:
- ライブデータ監視（5秒間隔で自動更新）
- 統計情報表示（総イベント数、ユニークユーザー、セッション数、クリック数）
- イベント履歴表示
- トラッキングスクリプト情報

**課題**:
- データがメモリ内のみ（サーバー再起動で消失）
- Redis Pub/Subを使用したリアルタイム更新が未実装

### 3. ヒートマップページ (`/heatmap`)
**実装状況**: ✅ 完了（モックデータ）

**機能**:
- ページ統計ダッシュボード
- 視覚的ヒートマップ表示（heatmap.js）
- 4タブ切替: クリック / スクロール / 熟読 / **画像**
- 詳細クリックデータ
- AI改善提案機能（UIのみ、実際のAI分析は未実装）
- 流入元・クエリ別分析
- クエリフィルター機能

#### 画像閲覧分析（画像タブ）
**実装状況**: ✅ 完了（2026-03-17）

ページ内の各画像がどの程度ユーザーに見られているかを数値化する機能。

**トラッキング**:
- `tracking.js` に Intersection Observer を追加し、全 `<img>` 要素の視認時間・表示割合を自動計測
- 小アイコン(30px未満)、data URI、SVGは自動除外
- `MutationObserver` で動的追加画像も追跡
- ページ離脱時に `image_visibility` イベントとして送信（上位30画像）

**データ収集項目**:
- `image_src` - 画像URL
- `image_alt` - alt属性
- `element_path` - CSSセレクタパス
- `image_y` - ページ上の絶対Y座標
- `image_width` / `image_height` - 画像サイズ
- `visible_duration_ms` - ビューポート内表示時間（ms）
- `max_visible_ratio` - 最大表示割合（0〜1.0）

**閲覧スコア算出**:
- `visibility_score` (0-100) = `avg_duration_ms × avg_max_ratio` を最大値で正規化
- 80-100: よく見られている（緑）
- 50-79: まずまず（黄）
- 20-49: 見られにくい（橙）
- 0-19: ほぼスルー（赤）

**UI**:
- ページプレビュー上に画像ごとのスコアバッジ + 枠線オーバーレイを表示
- オーバーレイクリック or テーブル行クリックで詳細モーダル表示
- モーダル: 画像プレビュー、SVGスコアリング、平均/最大視認時間、閲覧率、セッション統計
- 下部に画像別ランキングテーブル（ソート対応）

**ストレージ**: ClickHouse `clickinsight.image_visibility` テーブル
**API**: `GET /api/image-visibility?site_id=X&page_url=Y`

**課題**:
- 実際のヒートマップデータが表示されない
- AI分析機能が未実装

### 4. サイト管理ページ (`/sites`)
**実装状況**: ✅ 完了（ClickHouse統合済みコード）

**機能**:
- サイト登録・管理
- トラッキングID自動生成（形式: `CIP_` + 16文字）
- トラッキングコード生成・コピー機能
- サイト登録後のトラッキングID自動表示モーダル
- サイト一覧表示
- サイト削除機能
- GTM連携説明

**課題**:
- ClickHouseが未接続のため、データがメモリ内に保存される
- サーバー再起動でデータ消失

### 5. クリック分析ページ (`/clicks`)
**実装状況**: ✅ 完了（モックデータ）

**機能**:
- 詳細クリックデータ分析
- フィルター機能（サイト、期間、ページ）
- ページ別・デバイス別分析
- エクスポート機能（UIのみ）

**課題**:
- 実際のデータが表示されない
- エクスポート機能が未実装

### 6. AI分析ページ (`/ai-insights`)
**実装状況**: ⚠️ UIのみ実装、機能は未実装

**機能**:
- Claude Sonnet 4による自動分析（未実装）
- 優先度別改善提案（緊急・重要・SEO）（UIのみ）
- 実装コード自動生成（未実装）
- 分析履歴管理（UIのみ）

**課題**:
- Claude API連携が未実装
- 実際のAI分析機能が動作しない

### 7. セッション録画ページ (`/recordings`)
**実装状況**: ✅ 完了

**機能**:
- セッション録画データの表示
- 録画再生（rrweb-player）
- プライバシー対応（入力フィールドマスキング）

### 8. レポートページ (`/reports`)
**実装状況**: ⚠️ UIのみ実装

**機能**:
- 複数レポートテンプレート（UIのみ）
- 自動レポート生成（未実装）
- 生成済みレポート管理（UIのみ）
- 自動配信設定（未実装）

**課題**:
- レポート生成機能が未実装
- 自動配信機能が未実装

### 9. 設定ページ (`/settings`)
**実装状況**: ✅ 完了（UIのみ）

**機能**:
- トラッキングスクリプト管理（UIのみ）
- アカウント設定（UIのみ）
- 通知設定（UIのみ）
- データ管理（UIのみ）

**課題**:
- 実際の設定保存機能が未実装
- 認証システムがないため、ユーザー設定が保存できない

## 🔧 トラッキングシステム

### トラッキングスクリプト
**ファイル**: `public/track.js`, `public/tracking.js`

**実装状況**: ✅ 基本実装完了

**機能**:
- クリック、スクロール、マウス移動、ページビューの追跡
- セッション管理とユーザー識別
- 非同期データ送信
- エラーハンドリング
- UTMパラメータ・広告ID自動取得
- デバイスタイプ・リファラータイプ自動判定
- オプトアウト・Cookie同意チェック機能

**課題**:
- 本番環境URLがハードコードされていない（`localhost`が含まれている）
- スクリプトサイズが5KB以下に最適化されていない
- バッチ送信が未実装

### APIエンドポイント

#### `/api/track` (POST, GET)
**実装状況**: ✅ 完了（ClickHouse統合コード実装済み）

**機能**:
- トラッキングデータ受信
- バッチイベント対応
- ClickHouseへの保存（コード実装済み、接続待ち）
- Redis Pub/Subによるリアルタイム通知（コード実装済み、接続待ち）
- IP匿名化対応

#### `/api/events` (POST, GET)
**実装状況**: ✅ 完了（モック実装）

#### `/api/sites` (GET, POST)
**実装状況**: ✅ 完了（ClickHouse統合コード実装済み）

#### `/api/sites/[id]` (GET, PUT, DELETE)
**実装状況**: ✅ 完了（ClickHouse統合コード実装済み）

#### `/api/install` (GET)
**実装状況**: ✅ 完了

#### `/api/heatmap` (GET)
**実装状況**: ⚠️ モック実装

#### `/api/heatmap/query` (GET)
**実装状況**: ✅ 完了（クエリごとのヒートマップ取得）

#### `/api/gsc` (POST, GET)
**実装状況**: ✅ 完了（Google Search Consoleデータ取得・保存）

#### `/api/funnel` (GET)
**実装状況**: ✅ 完了（ファネル分析）

#### `/api/recordings` (POST, GET)
**実装状況**: ✅ 完了（セッション録画データ受信・取得）

## 🗄️ データベース設計

### ClickHouse

#### データベース: `clickinsight`

#### テーブル1: `sites`
**スキーマ**:
```sql
CREATE TABLE IF NOT EXISTS clickinsight.sites (
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
ORDER BY (id)
```

#### テーブル2: `events`（拡張版：収益・広告連携対応）
**スキーマ**:
```sql
CREATE TABLE IF NOT EXISTS clickinsight.events (
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
PARTITION BY toYYYYMM(timestamp)
```

#### テーブル3: `sessions`（セッション集約）
**スキーマ**:
```sql
CREATE TABLE IF NOT EXISTS clickinsight.sessions (
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
PARTITION BY toYYYYMM(start_time)
```

#### テーブル4: `heatmap_summary`（集計済みヒートマップキャッシュ）
**スキーマ**:
```sql
CREATE TABLE IF NOT EXISTS clickinsight.heatmap_summary (
    site_id String,
    page_url String,
    date Date,
    x UInt16,
    y UInt16,
    click_count UInt32,
    updated_at DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (site_id, page_url, date)
PARTITION BY toYYYYMM(date)
```

#### テーブル5: `users`（マルチテナント対応）
**スキーマ**:
```sql
CREATE TABLE IF NOT EXISTS clickinsight.users (
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
ORDER BY (id)
```

#### テーブル6: `gsc_data`（Google Search Consoleデータ）
**スキーマ**:
```sql
CREATE TABLE IF NOT EXISTS clickinsight.gsc_data (
    site_id String,
    date Date,
    query String,
    page String,
    clicks UInt32,
    impressions UInt32,
    ctr Float32,
    position Float32,
    device String
) ENGINE = MergeTree()
ORDER BY (site_id, date, query)
PARTITION BY toYYYYMM(date)
```

#### テーブル7: `session_recordings`（セッション録画）
**スキーマ**:
```sql
CREATE TABLE IF NOT EXISTS clickinsight.session_recordings (
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
PARTITION BY toYYYYMM(start_time)
```

### Redis

**用途**:
- ヒートマップデータのキャッシュ（TTL: 1時間）
- 統計データのキャッシュ（TTL: 30分）
- セッションデータのキャッシュ（TTL: 24時間）
- リアルタイムデータのPub/Sub

## 🤖 Phase 2: AI機能仕様（RAG + ML統合）

### アーキテクチャ概要

ClickInsight ProのAI機能は、**RAG（Retrieval-Augmented Generation）**と**ML（機械学習）モデル**を組み合わせた独自のアーキテクチャを採用します。

### データ学習システム

**目的**: 大量の行動データと収益データから、コンバージョンに影響するパターンを学習

**実装内容**:

1. **特徴量エンジニアリング**
   - クリック位置、スクロール深度、滞在時間
   - ページ遷移パターン、離脱ポイント
   - デバイスタイプ、流入元、UTMパラメータ
   - 検索クエリ、ランディングページ
   - 収益データ（コンバージョン有無、金額）

2. **MLモデル**
   - **コンバージョン予測モデル**: セッションからコンバージョン確率を予測
   - **離脱予測モデル**: 離脱リスクの高いセッションを検出
   - **収益予測モデル**: セッションあたりの収益を予測
   - **セグメント分類モデル**: ユーザー行動パターンからセグメントを自動分類

3. **モデル更新スケジュール**
   - **日次更新**: 前日のデータでモデルを再学習
   - **週次更新**: 過去1週間のデータでモデルを再学習
   - **月次更新**: 過去1ヶ月のデータでモデルを再学習

### RAG（Retrieval-Augmented Generation）システム

**目的**: 過去の成功事例、ベストプラクティス、学習済みパターンから最適な改善提案を生成

**実装内容**:

1. **ベクトルデータベース構築**
   - **成功事例**: 過去の改善施策とその効果
   - **ベストプラクティス**: CRO、SEO、UXのベストプラクティス
   - **学習パターン**: MLモデルが発見したパターン
   - **業界知識**: 業界別の改善事例

2. **検索・生成フロー**
   ```
   1. ユーザーのサイトデータを分析
   2. 問題点・改善ポイントを特定
   3. ベクトルDBから類似事例を検索（Top-K）
   4. 検索結果とサイトデータをLLMに渡す
   5. LLMが改善提案を生成
   6. 優先度付け（MLモデルの予測スコアを使用）
   7. 実装コードを自動生成
   ```

3. **LLM統合**
   - **Claude API** (Anthropic): メインのLLM
   - **GPT-4** (OpenAI): バックアップLLM
   - **プロンプトエンジニアリング**: 改善提案生成用のプロンプトテンプレート

### AI提案生成フロー

1. **データ分析**: サイトの行動データを分析
2. **問題点の特定**: 問題点を自動検出
3. **RAG検索**: 類似事例を検索
4. **改善提案生成**: LLMで改善提案を生成
5. **優先度付け**: MLモデルの予測スコアで優先度付け
6. **実装コード生成**: 実装コードを自動生成

## 📊 料金プラン

| プラン | 月額 | PV/月 | サイト数 | 主な機能 |
|--------|------|-------|---------|---------|
| Free | ¥0 | 5,000 | 1 | 基本ヒートマップ |
| Starter | ¥4,980 | 50,000 | 3 | AI分析、GSC連携 |
| Professional | ¥9,800 | 500,000 | 10 | 全機能、API |
| Business | ¥24,800 | 2,000,000 | 50 | 無制限AI分析 |

## 📈 成功指標

### 技術指標
- ページ読み込み時間: < 2秒
- トラッキングスクリプトサイズ: < 5KB
- API応答時間: < 500ms
- データ精度: > 99%
- リアルタイム更新遅延: < 1秒
- MLモデル精度: > 85%

### ビジネス指標
- ユーザー満足度: > 4.5/5
- 機能利用率: > 80%
- データ保持率: > 95%
- システム稼働率: > 99.9%
- AI提案の実装率: > 30%

## 📝 更新履歴

- **2025-01-26**: ドキュメント整理 - SPECIFICATIONS.md作成（仕様書を統合）
- **2025-01-25**: 完全仕様書作成、Phase 1完了項目の記録、Phase 2 AI機能の詳細仕様

