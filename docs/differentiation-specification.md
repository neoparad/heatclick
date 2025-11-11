# 🔍 ClickInsight Pro - 差別化設計書

最終更新: 2025年1月25日

## 📋 プロジェクト概要

**プロジェクト名**: ClickInsight Pro  
**コンセプト**: 「SEO × UX × AI Insight」— 検索意図と行動データを統合する"知能型ヒートマップ分析"  
**競合**: Heatmap.com（Revenue Visualization × CRO特化）  
**差別化ポイント**: 検索流入キーワード別のクリック熱量、売上に結びつく導線、AIによる改善提案

---

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

---

## 🧩 Phase 1: 基盤完成（優先度: 高）

### 1.1 データ構造 / 収益統合

#### 実装内容
- [x] ClickHouse接続基盤
- [x] `event_revenue` カラム追加
- [x] UTMパラメータ・広告ID取得機能（`gclid`, `fbclid`）
- [x] セッション集約テーブル（`sessions`）作成
- [ ] GA4 / Shopify / Affiliate API連携
- [ ] セッション単位で「クリック→収益」を可視化（UI実装待ち）

#### データベーススキーマ拡張

```sql
-- eventsテーブルに追加
ALTER TABLE clickinsight.events
ADD COLUMN IF NOT EXISTS event_revenue Decimal(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS utm_source String,
ADD COLUMN IF NOT EXISTS utm_medium String,
ADD COLUMN IF NOT EXISTS utm_campaign String,
ADD COLUMN IF NOT EXISTS gclid String,
ADD COLUMN IF NOT EXISTS fbclid String,
ADD COLUMN IF NOT EXISTS conversion_type String,
ADD COLUMN IF NOT EXISTS conversion_value Decimal(10, 2) DEFAULT 0;

-- セッション集約テーブル（新規）
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
  conversion_type String,
  landing_page String,
  exit_page String,
  utm_source String,
  utm_medium String,
  utm_campaign String,
  search_query String,
  device_type String,
  referrer_type String
) ENGINE = MergeTree()
ORDER BY (site_id, start_time)
PARTITION BY toYYYYMM(start_time);
```

### 1.2 広告連携

#### 実装内容
- [x] `utm_source` + `gclid/fbclid` を自動取得（トラッキングスクリプト実装済み）
- [x] デバイスタイプ・リファラータイプ自動判定
- [ ] Google Ads API 連携
- [ ] Meta Ads API 連携
- [ ] 「広告→行動→収益」分析を実装（UI実装待ち）

#### トラッキングスクリプト拡張

```javascript
// UTMパラメータと広告IDの自動取得
const getUtmParams = () => {
  const params = new URLSearchParams(window.location.search);
  return {
    utm_source: params.get('utm_source') || '',
    utm_medium: params.get('utm_medium') || '',
    utm_campaign: params.get('utm_campaign') || '',
    utm_term: params.get('utm_term') || '',
    utm_content: params.get('utm_content') || '',
    gclid: params.get('gclid') || '',
    fbclid: params.get('fbclid') || '',
  };
};
```

### 1.3 認証システム / マルチテナント

#### 実装内容
- [x] NextAuth.js基盤（一部実装済み）
- [x] ClickHouse usersテーブル
- [ ] `org_id` 列でテナント分離
- [ ] 各ユーザーにアクセス制御

#### データベーススキーマ

```sql
-- usersテーブル拡張
ALTER TABLE clickinsight.users
ADD COLUMN IF NOT EXISTS org_id String,
ADD COLUMN IF NOT EXISTS role String DEFAULT 'user';

-- sitesテーブル拡張
ALTER TABLE clickinsight.sites
ADD COLUMN IF NOT EXISTS user_id String,
ADD COLUMN IF NOT EXISTS org_id String;
```

### 1.4 リアルタイム分析

#### 実装内容
- [x] Redis接続基盤
- [x] Redis Pub/Sub実装（`lib/redis.ts`に`publishRealtimeData`実装済み）
- [x] リアルタイムクリック反映（`app/api/track/route.ts`で実装済み）
- [ ] ヒートマップ差分更新（フロントエンド実装待ち）

---

## 🚀 Phase 2: 差別化機能（優先度: 中）

### 2.1 AI インサイト

#### 実装内容
- [x] Claude API連携UI（完成済み）
- [ ] 行動＋売上データをRAG化
- [ ] LLMで「離脱要因・UI改善提案・優先度」自動出力
- [ ] LangChain + ClickHouse 接続でクエリ自動生成

### 2.2 SEO × UX 統合分析

#### 実装内容
- [ ] Google Search Console API連携
- [ ] GSC CTR / 平均順位 × ヒートマップ統合
- [ ] 「SEO×UX解析」ダッシュボード

#### データ構造

```sql
-- GSCデータ統合テーブル（新規）
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
PARTITION BY toYYYYMM(date);
```

### 2.3 広告別 ROI ヒートマップ

#### 実装内容
- [ ] Google Ads API 連携
- [ ] Meta Ads API 連携
- [ ] 広告別ROIヒートマップ表示

---

## 🤖 Phase 3: 上位拡張（優先度: 低）

### 3.1 ファネル分析

#### 実装内容
- [x] `session_id` ごとのURL遷移をClickHouseで再構成（`lib/session-aggregator.ts`実装済み）
- [x] ファネル分析API実装（`app/api/funnel/route.ts`）
- [ ] Graph View / Sankey Diagram で可視化（フロントエンド実装待ち）

### 3.2 セッションリプレイ

#### 実装内容
- [ ] 軽量ライブラリ (rrweb / OpenReplay) 導入
- [ ] ヒートマップと同期再生可能な「行動プレイヤー」をUI統合

### 3.3 キャッシュ設計 / 高速化

#### 実装内容
- [ ] `event_summary` テーブルで集計済みヒートマップキャッシュを保持
- [ ] 描画を高速化

#### データベーススキーマ

```sql
-- 集計済みヒートマップデータ（新規）
CREATE TABLE IF NOT EXISTS clickinsight.heatmap_summary (
  site_id String,
  page_url String,
  date Date,
  device_type String,
  click_data String, -- JSON形式
  scroll_data String, -- JSON形式
  click_count UInt32,
  scroll_depth_avg Float32,
  last_updated DateTime
) ENGINE = ReplacingMergeTree(last_updated)
ORDER BY (site_id, page_url, date, device_type)
PARTITION BY toYYYYMM(date);
```

### 3.4 パフォーマンス最適化

#### 実装内容
- [x] バッチ送信実装（一部実装済み）
- [ ] イベント送信を `navigator.sendBeacon` 完全対応
- [ ] クリック/スクロールを `requestIdleCallback` で処理

### 3.5 GDPR / プライバシー対応

#### 実装内容
- [x] IP匿名化（`lib/privacy.ts`実装済み、`app/api/track/route.ts`で適用）
- [x] オプトアウト設定（`lib/privacy.ts`、`public/tracking.js`実装済み）
- [x] Cookie同意API対応（`lib/privacy.ts`、`public/tracking.js`実装済み）

### 3.6 レポート自動生成

#### 実装内容
- [ ] AI レポートテンプレートをJSON構成化
- [ ] 週次/月次で自動生成
- [ ] メール配信（Resend or SendGrid）

### 3.7 A/B テスト連携

#### 実装内容
- [ ] `variant_id` 付きイベントを記録
- [ ] ヒートマップ比較表示を実装

---

## 📊 データフロー設計

### イベント収集フロー

```
1. トラッキングスクリプト（クライアント）
   ↓
2. バッチ送信（sendBeacon / fetch）
   ↓
3. API Route (/api/track)
   ↓
4. Rate Limiting
   ↓
5. ClickHouse挿入（eventsテーブル）
   ↓
6. Redis Pub/Sub（リアルタイム通知）
   ↓
7. 集計処理（バッチ/リアルタイム）
   ↓
8. heatmap_summaryテーブル更新
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

---

## 🔧 技術スタック

### フロントエンド
- Next.js 14 (App Router)
- React 18 + TypeScript
- Tailwind CSS + shadcn/ui
- Recharts（チャート）
- heatmap.js（ヒートマップ）

### バックエンド
- Next.js API Routes
- ClickHouse（データストレージ）
- Redis（キャッシュ、Pub/Sub）
- NextAuth.js（認証）

### 外部API連携
- Google Search Console API
- Google Ads API
- Meta Ads API
- GA4 API
- Claude API（AI分析）
- Shopify API（収益データ）

### インフラ
- Vercel（フロントエンド）
- Hetzner Cloud（データベース）
- Redis（キャッシュ）

---

## 📈 成功指標

### 技術指標
- ページ読み込み時間: < 2秒
- トラッキングスクリプトサイズ: < 5KB
- API応答時間: < 500ms
- データ精度: > 99%
- リアルタイム更新遅延: < 1秒

### ビジネス指標
- ユーザー満足度: > 4.5/5
- 機能利用率: > 80%
- データ保持率: > 95%
- システム稼働率: > 99.9%

---

## 🗓️ ロードマップ

### Phase 1: 基盤完成（1-2ヶ月）
- [x] ClickHouse接続
- [x] Redis接続
- [x] 認証システム（一部）
- [ ] 収益統合
- [ ] 広告連携
- [ ] リアルタイム分析

### Phase 2: 差別化機能（2-3ヶ月）
- [ ] AI インサイト実装
- [ ] SEO × UX 統合分析
- [ ] 広告別 ROI ヒートマップ

### Phase 3: 上位拡張（3-6ヶ月）
- [ ] ファネル分析
- [ ] セッションリプレイ
- [ ] キャッシュ設計
- [ ] GDPR対応
- [ ] レポート自動生成
- [ ] A/Bテスト連携

---

## 📝 更新履歴

- **2025-01-25**: 差別化設計書作成
  - Heatmap.comとの比較分析
  - Phase別実装計画
  - データベーススキーマ拡張案

