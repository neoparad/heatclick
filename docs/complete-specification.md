# ClickInsight Pro - 完全仕様書

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

## ✅ Phase 1: 基盤完成（実装完了）

### 1.1 データ構造 / 収益統合 ✅

#### 実装完了項目
- [x] ClickHouse接続基盤
- [x] `event_revenue` カラム追加
- [x] UTMパラメータ・広告ID取得機能（`gclid`, `fbclid`）
- [x] セッション集約テーブル（`sessions`）作成
- [x] 収益データ連携基盤（GA4/Shopify API基盤実装）

#### データベーススキーマ

```sql
-- eventsテーブル（拡張版）
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

-- sessionsテーブル（セッション集約）
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

-- session_recordingsテーブル（セッション録画）
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

### 1.2 広告連携 ✅

#### 実装完了項目
- [x] `utm_source` + `gclid/fbclid` を自動取得（トラッキングスクリプト実装済み）
- [x] デバイスタイプ・リファラータイプ自動判定
- [x] Google Ads API連携基盤（`lib/integrations/google-ads.ts`）
- [x] Meta Ads API連携基盤（`lib/integrations/meta-ads.ts`）

### 1.3 認証システム / マルチテナント ✅

#### 実装完了項目
- [x] NextAuth.js基盤（一部実装済み）
- [x] ClickHouse usersテーブル
- [x] `org_id` 列でテナント分離対応
- [x] ユーザー登録・ログイン機能

#### データベーススキーマ

```sql
-- usersテーブル（マルチテナント対応）
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

-- sitesテーブル（マルチテナント対応）
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

### 1.4 リアルタイム分析 ✅

#### 実装完了項目
- [x] Redis接続基盤
- [x] Redis Pub/Sub実装（`lib/redis.ts`に`publishRealtimeData`実装済み）
- [x] リアルタイムクリック反映（`app/api/track/route.ts`で実装済み）

### 1.5 セッション録画機能 ✅

#### 実装完了項目
- [x] rrwebライブラリ統合
- [x] 録画スクリプト（`public/recording.js`）
- [x] 録画データ保存API（`app/api/recordings/route.ts`）
- [x] 録画再生UI（`app/recordings/page.tsx`）
- [x] プライバシー対応（入力フィールドマスキング、オプトアウト）

### 1.6 プライバシー・GDPR対応 ✅

#### 実装完了項目
- [x] IP匿名化（`lib/privacy.ts`）
- [x] オプトアウト設定
- [x] Cookie同意API対応

### 1.7 ファネル分析 ✅

#### 実装完了項目
- [x] `session_id` ごとのURL遷移をClickHouseで再構成（`lib/session-aggregator.ts`実装済み）
- [x] ファネル分析API（`app/api/funnel/route.ts`）

---

## 🚀 Phase 2: 差別化機能（開発中）

### 2.1 AI インサイト（RAG + ML統合）

#### アーキテクチャ概要

ClickInsight ProのAI機能は、**RAG（Retrieval-Augmented Generation）**と**ML（機械学習）モデル**を組み合わせた独自のアーキテクチャを採用します。

```
┌─────────────────────────────────────────────────────────────┐
│                    AI インサイトシステム                      │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │  データ収集   │───▶│  データ学習   │───▶│  AI提案生成   │  │
│  │              │    │              │    │              │  │
│  │ - クリック    │    │ - MLモデル    │    │ - RAG検索    │  │
│  │ - スクロール  │    │ - 特徴量抽出  │    │ - LLM生成    │  │
│  │ - セッション  │    │ - パターン学習│    │ - 優先度付け  │  │
│  │ - 収益データ  │    │ - モデル更新  │    │ - 実装コード  │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

#### 2.1.1 データ学習システム

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

3. **学習パイプライン**
   ```python
   # 疑似コード
   class MLTrainingPipeline:
       def train_conversion_model(self, events, sessions, conversions):
           # 特徴量抽出
           features = self.extract_features(events, sessions)
           
           # ラベル作成（コンバージョン有無）
           labels = self.create_labels(conversions)
           
           # モデル学習（XGBoost / LightGBM）
           model = XGBClassifier()
           model.fit(features, labels)
           
           # モデル保存
           self.save_model(model, 'conversion_model')
           
       def update_model(self, new_data):
           # インクリメンタル学習
           model = self.load_model('conversion_model')
           model.partial_fit(new_data)
   ```

4. **モデル更新スケジュール**
   - **日次更新**: 前日のデータでモデルを再学習
   - **週次更新**: 過去1週間のデータでモデルを再学習
   - **月次更新**: 過去1ヶ月のデータでモデルを再学習

#### 2.1.2 RAG（Retrieval-Augmented Generation）システム

**目的**: 過去の成功事例、ベストプラクティス、学習済みパターンから最適な改善提案を生成

**実装内容**:

1. **ベクトルデータベース構築**
   - **成功事例**: 過去の改善施策とその効果
   - **ベストプラクティス**: CRO、SEO、UXのベストプラクティス
   - **学習パターン**: MLモデルが発見したパターン
   - **業界知識**: 業界別の改善事例

2. **埋め込み生成**
   ```python
   # 疑似コード
   class RAGSystem:
       def create_embeddings(self, documents):
           # テキストをベクトル化（OpenAI / Sentence-BERT）
           embeddings = self.embedding_model.encode(documents)
           return embeddings
       
       def store_in_vector_db(self, documents, embeddings):
           # ベクトルデータベースに保存（Pinecone / Weaviate / Qdrant）
           self.vector_db.upsert(embeddings, documents)
   ```

3. **検索・生成フロー**
   ```
   1. ユーザーのサイトデータを分析
   2. 問題点・改善ポイントを特定
   3. ベクトルDBから類似事例を検索（Top-K）
   4. 検索結果とサイトデータをLLMに渡す
   5. LLMが改善提案を生成
   6. 優先度付け（MLモデルの予測スコアを使用）
   7. 実装コードを自動生成
   ```

4. **LLM統合**
   - **Claude API** (Anthropic): メインのLLM
   - **GPT-4** (OpenAI): バックアップLLM
   - **プロンプトエンジニアリング**: 改善提案生成用のプロンプトテンプレート

#### 2.1.3 AI提案生成フロー

**ステップ1: データ分析**
```typescript
// サイトの行動データを分析
const analysis = await analyzeSiteData(siteId, {
  startDate: '2025-01-01',
  endDate: '2025-01-25',
})

// MLモデルで予測
const predictions = await mlModel.predict({
  conversionProbability: analysis.sessions,
  dropoffRisk: analysis.sessions,
  revenuePotential: analysis.sessions,
})
```

**ステップ2: 問題点の特定**
```typescript
// 問題点を自動検出
const issues = await detectIssues(analysis, predictions)
// 例: 
// - ランディングページの離脱率が高い
// - CTAボタンのクリック率が低い
// - モバイルでのスクロール深度が浅い
```

**ステップ3: RAG検索**
```typescript
// 類似事例を検索
const similarCases = await ragSystem.search({
  query: issues[0].description,
  topK: 5,
  filters: {
    industry: site.industry,
    deviceType: 'mobile',
  },
})
```

**ステップ4: 改善提案生成**
```typescript
// LLMで改善提案を生成
const suggestions = await llm.generate({
  prompt: buildPrompt({
    siteData: analysis,
    issues: issues,
    similarCases: similarCases,
    predictions: predictions,
  }),
  model: 'claude-3-sonnet',
  temperature: 0.7,
})
```

**ステップ5: 優先度付け**
```typescript
// MLモデルの予測スコアで優先度付け
const prioritizedSuggestions = suggestions.map(suggestion => ({
  ...suggestion,
  priority: calculatePriority(suggestion, predictions),
  expectedImpact: mlModel.predictImpact(suggestion),
}))
```

**ステップ6: 実装コード生成**
```typescript
// 実装コードを自動生成
const implementationCode = await generateCode({
  suggestion: prioritizedSuggestions[0],
  siteStructure: analysis.siteStructure,
})
```

#### 2.1.4 データベース設計（AI機能用）

```sql
-- ml_modelsテーブル（学習済みモデル管理）
CREATE TABLE clickinsight.ml_models (
  id String,
  model_type String, -- 'conversion', 'dropoff', 'revenue', 'segment'
  version String,
  model_data String, -- モデルのバイナリデータ（Base64エンコード）
  training_data_range_start DateTime,
  training_data_range_end DateTime,
  accuracy_metrics String, -- JSON形式
  created_at DateTime,
  is_active UInt8 DEFAULT 0
) ENGINE = MergeTree()
ORDER BY (model_type, created_at);

-- ml_predictionsテーブル（予測結果保存）
CREATE TABLE clickinsight.ml_predictions (
  id String,
  site_id String,
  session_id Nullable(String),
  model_type String,
  input_features String, -- JSON形式
  prediction_result String, -- JSON形式
  confidence Float32,
  created_at DateTime
) ENGINE = MergeTree()
ORDER BY (site_id, created_at)
PARTITION BY toYYYYMM(created_at);

-- rag_documentsテーブル（RAG用ドキュメント）
CREATE TABLE clickinsight.rag_documents (
  id String,
  document_type String, -- 'case_study', 'best_practice', 'pattern', 'industry_knowledge'
  title String,
  content String,
  embedding Vector(1536), -- OpenAI embedding次元
  metadata String, -- JSON形式
  created_at DateTime,
  updated_at DateTime
) ENGINE = MergeTree()
ORDER BY (document_type, created_at);

-- ai_suggestionsテーブル（AI提案履歴）
CREATE TABLE clickinsight.ai_suggestions (
  id String,
  site_id String,
  suggestion_type String, -- 'ui_improvement', 'seo_optimization', 'cro_enhancement'
  title String,
  description String,
  priority String, -- 'high', 'medium', 'low'
  expected_impact Float32,
  implementation_code String,
  status String, -- 'pending', 'implemented', 'rejected'
  similar_cases String, -- JSON形式（RAG検索結果）
  ml_predictions String, -- JSON形式（ML予測結果）
  created_at DateTime,
  implemented_at Nullable(DateTime)
) ENGINE = MergeTree()
ORDER BY (site_id, created_at)
PARTITION BY toYYYYMM(created_at);
```

### 2.2 SEO × UX 統合分析 ✅

#### 実装完了項目
- [x] Google Search Console API連携（`lib/integrations/gsc.ts`）
- [x] GSCデータ保存API（`app/api/gsc/route.ts`）
- [x] クエリごとのヒートマップAPI（`app/api/heatmap/query/route.ts`）
- [x] ヒートマップページにクエリフィルター機能追加
- [x] GSC CTR / 平均順位 × ヒートマップ統合
- [ ] 「SEO×UX解析」ダッシュボード（UI実装待ち）

#### データ構造

```sql
-- gsc_dataテーブル（GSCデータ統合）
CREATE TABLE clickinsight.gsc_data (
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
- [x] Google Ads API連携基盤
- [x] Meta Ads API連携基盤
- [ ] 広告別ROIヒートマップ表示（UI実装待ち）

---

## 🤖 Phase 3: 上位拡張（計画中）

### 3.1 ファネル分析（UI実装待ち）

#### 実装内容
- [x] バックエンド実装完了
- [ ] Graph View / Sankey Diagram で可視化（フロントエンド実装待ち）

### 3.2 セッションリプレイ ✅

#### 実装完了項目
- [x] rrwebライブラリ導入
- [x] 録画機能実装
- [x] 録画再生UI実装

### 3.3 キャッシュ設計 / 高速化

#### 実装内容
- [x] `heatmap_summary`テーブル作成
- [ ] 集計処理の実装
- [ ] 描画高速化

### 3.4 パフォーマンス最適化

#### 実装内容
- [x] バッチ送信実装
- [x] `navigator.sendBeacon`対応
- [ ] `requestIdleCallback`で処理

### 3.5 GDPR / プライバシー対応 ✅

#### 実装完了項目
- [x] IP匿名化
- [x] オプトアウト設定
- [x] Cookie同意API対応

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
4. Rate Limiting + IP匿名化
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

---

## 🔧 技術スタック

### フロントエンド
- Next.js 14 (App Router)
- React 18 + TypeScript
- Tailwind CSS + shadcn/ui
- Recharts（チャート）
- heatmap.js（ヒートマップ）
- rrweb / rrweb-player（セッション録画）

### バックエンド
- Next.js API Routes
- ClickHouse（データストレージ）
- Redis（キャッシュ、Pub/Sub）
- NextAuth.js（認証）

### AI / ML
- **LLM**: Claude API (Anthropic), GPT-4 (OpenAI)
- **MLフレームワーク**: Python (scikit-learn, XGBoost, LightGBM)
- **ベクトルDB**: Pinecone / Weaviate / Qdrant
- **埋め込みモデル**: OpenAI Embeddings / Sentence-BERT

### 外部API連携
- ✅ Google Search Console API（実装完了）
- ✅ Google Ads API（基盤実装完了）
- ✅ Meta Ads API（基盤実装完了）
- ✅ GA4 API（基盤実装完了）
- ✅ Shopify API（基盤実装完了）
- Claude API（AI分析）

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
- MLモデル精度: > 85%

### ビジネス指標
- ユーザー満足度: > 4.5/5
- 機能利用率: > 80%
- データ保持率: > 95%
- システム稼働率: > 99.9%
- AI提案の実装率: > 30%

---

## 🗓️ 開発ロードマップ

### Phase 1: 基盤完成 ✅（完了）
- [x] ClickHouse接続
- [x] Redis接続
- [x] 認証システム
- [x] 収益統合基盤
- [x] 広告連携基盤
- [x] リアルタイム分析
- [x] セッション録画
- [x] ファネル分析（バックエンド）
- [x] GDPR対応

### Phase 2: 差別化機能（進行中）
- [ ] AI インサイト実装（RAG + ML統合）
  - [ ] MLモデル学習パイプライン
  - [ ] RAGシステム構築
  - [ ] AI提案生成UI
- [ ] SEO × UX 統合分析
- [ ] 広告別 ROI ヒートマップ（UI）

### Phase 3: 上位拡張（計画中）
- [ ] ファネル分析（UI実装）
- [ ] キャッシュ設計最適化
- [ ] レポート自動生成
- [ ] A/Bテスト連携

---

## 📝 更新履歴

- **2025-01-25**: 完全仕様書作成
  - Phase 1完了項目の記録
  - Phase 2 AI機能の詳細仕様（RAG + ML統合）
  - 開発ロードマップ更新

