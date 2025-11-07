# HeatClick - RAG & ML統合構想書
## CV改善AIプラットフォームへの進化

最終更新: 2025年1月25日

---

## 📋 目次

1. [システム概要](#1-システム概要)
2. [システムアーキテクチャ](#2-システムアーキテクチャ)
3. [データ収集層の仕様](#3-データ収集層の仕様)
4. [AI分析層の仕様](#4-ai分析層の仕様)
5. [機能詳細仕様](#5-機能詳細仕様)
6. [データベース設計](#6-データベース設計)
7. [技術スタック](#7-技術スタック)
8. [実装ロードマップ](#8-実装ロードマップ)
9. [KPI・成果指標](#9-kpi成果指標)

---

## 1. システム概要

### 1.1 製品名

**HeatClick Pro** - AI搭載インテリジェント・クリック分析＆CV改善プラットフォーム

### 1.2 製品の目的

既存のヒートマップ＆クリック分析ツールに、RAG（知識ベース）とML（機械学習）を組み合わせ、単なる可視化ツールから「自動診断・予測・改善提案」を行うインテリジェントなCRO（コンバージョン最適化）プラットフォームへと進化させる。

### 1.3 コアバリュー

- **予測**: 実際にクリックされる前に、効果を予測
- **診断**: なぜそうなっているのかを自動解説
- **提案**: 何をすべきかを具体的に提示
- **学習**: 使えば使うほど精度向上（ネットワーク効果）

### 1.4 差別化要因

- **linkscrawl統合**: 競合・業界データで予測精度を劇的向上
- **RAG知識ベース**: 10-20社の実案件 + 業界ベストプラクティス
- **流入元別AI最適化**: 広告・クエリごとに最適な体験を予測
- **日本市場特化**: 日本語・日本の商習慣に最適化
- **SEO特化**: 既存のSEOコンサル知見を活用

### 1.5 既存機能との統合

既存のHeatClick（ClickInsight Pro）の機能を拡張：

- ✅ 既存: ヒートマップ表示 → 強化: AI予測ヒートマップ
- ✅ 既存: 流入元分析 → 強化: 流入元別最適化モデル
- ✅ 既存: AI分析（Claude API） → 強化: RAG統合分析
- 🆕 新規: ML予測エンジン（クリック予測、CVR予測）
- 🆕 新規: セグメント分析
- 🆕 新規: 競合分析（linkscrawl統合）

---

## 2. システムアーキテクチャ

### 2.1 全体構成図

```
┌─────────────────────────────────────────────────────────┐
│                  フロントエンド層                          │
│  Next.js 14 (App Router) + React 18 + TypeScript       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │ダッシュ  │  │リアルタイム│  │レポート  │            │
│  │ボード    │  │アラート    │  │生成      │            │
│  └──────────┘  └──────────┘  └──────────┘            │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│                    API層（Next.js API Routes）           │
│  - 認証/認可  - レート制限  - キャッシング               │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│                  データ収集層                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │既存:      │  │既存:      │  │新規:     │            │
│  │ヒートマップ│  │流入元    │  │セッション│            │
│  │トラッキング│  │分析      │  │録画      │            │
│  └──────────┘  └──────────┘  └──────────┘            │
│  ┌─────────────────────────────────────────────┐       │
│  │  新規: linkscrawl統合                       │       │
│  │  - 競合サイトクロール                       │       │
│  │  - UI/UX分析                                │       │
│  │  - 業界ベンチマーク取得                     │       │
│  └─────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│                  データ統合層                              │
│  ┌─────────────────────────────────────────────┐       │
│  │  リアルタイム処理（Redis Streams）          │       │
│  │  - イベント集約  - セッション管理           │       │
│  └─────────────────────────────────────────────┘       │
│  ┌─────────────────────────────────────────────┐       │
│  │  バッチ処理（夜間・Python/Celery）         │       │
│  │  - データクレンジング  - 集計               │       │
│  └─────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│                  AI分析層                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │RAGシステム│  │MLモデル群│  │linkscrawl│            │
│  │          │  │          │  │統合      │            │
│  │- 知識検索│  │- 予測    │  │          │            │
│  │- 事例提示│  │- 分類    │  │- 競合分析│            │
│  │- 提案生成│  │- 異常検知│  │- ベンチ  │            │
│  └──────────┘  └──────────┘  └──────────┘            │
│                     ↓                                     │
│  ┌──────────────────────────────────────────┐           │
│  │    Claude Sonnet 4 API（最終統合）       │           │
│  │    - レポート生成  - 改善提案生成        │           │
│  └──────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│                  データストレージ層                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │PostgreSQL │  │ClickHouse │  │Redis     │            │
│  │(Supabase)│  │(時系列)  │  │(キャッシュ)│            │
│  │- メタデータ│ │- イベント │ │- セッション│            │
│  │- ベクトルDB│ │- 集約    │ │- リアルタイム│          │
│  └──────────┘  └──────────┘  └──────────┘            │
│  ┌──────────┐  ┌──────────┐                           │
│  │S3/Storage│  │          │                           │
│  │(ログ)    │  │          │                           │
│  └──────────┘  └──────────┘                           │
└─────────────────────────────────────────────────────────┘
```

### 2.2 データフロー

#### 2.2.1 リアルタイムフロー（ユーザー訪問時）

```
1. ユーザーがサイト訪問
   ↓
2. トラッキングJS実行（既存: public/track.js）
   - クリック、スクロール、マウス移動を記録
   - 流入元情報を取得（広告ID、検索クエリ等）
   ↓
3. イベントをバックエンドに送信（既存: /api/track）
   ↓
4. リアルタイム処理
   - Redis Streamsでイベント集約
   - セッションID紐付け
   - 異常検知モデル適用（ボット判定）
   ↓
5. ML予測エンジン実行（新規）
   - リアルタイムCVR予測
   - セグメント分類
   - 離脱リスク判定
   ↓
6. 必要に応じてアラート
   - 高確度ユーザー検知 → 営業に通知
   - 異常パターン検知 → 管理者に通知
   ↓
7. データ永続化
   - ClickHouseに時系列データ保存
   - PostgreSQLにセッションサマリ保存
```

#### 2.2.2 バッチフロー（夜間処理）

```
1. 日次データ集計
   ↓
2. linkscrawlデータ統合（新規）
   - 競合サイトの最新データ取得
   - 業界ベンチマーク更新
   ↓
3. MLモデル再学習（新規）
   - 新しいデータで予測モデル更新
   - 精度メトリクス計算
   ↓
4. RAG知識ベース更新（新規）
   - 新規事例の追加
   - ベクトル埋め込み生成
   ↓
5. レポート自動生成（既存機能拡張）
   - 週次/月次レポート作成
   - 改善提案の生成
   ↓
6. 顧客への配信
   - メール送信
   - ダッシュボード更新
```

---

## 3. データ収集層の仕様

### 3.1 既存トラッキングスクリプトの拡張

#### 3.1.1 現在の収集データ（既存）

- **クリックイベント**: 座標、要素情報
- **スクロールイベント**: スクロール深度
- **セッション情報**: セッションID、訪問回数
- **流入元情報**: UTMパラメータ、リファラー
- **デバイス情報**: デバイスタイプ、OS、ブラウザ

#### 3.1.2 追加収集データ（新規）

**【フォーカスイベント】**

- 入力フィールドのフォーカス
- 入力時間
- 入力文字数（内容は取らない）

**【マウス移動イベント】**

- 軌跡データ（サンプリング：100ms間隔）
- ホバー時間（要素ごと）
- マウスアウト回数

**【コンバージョン情報】**

- コンバージョンタイプ（購入、問い合わせ、登録等）
- コンバージョン時刻
- コンバージョン金額
- マイクロコンバージョン（資料ダウンロード等）

**【ページ情報】**

- ページ読み込み時間
- エラー発生情報

### 3.2 linkscrawl統合仕様

#### 3.2.1 linkscrawlからのデータ取得

**【サイト構造データ】**

- URL構造（階層、命名規則）
- ページ数
- 内部リンク構造
- サイトマップ

**【UI/UXデータ】**

- ファーストビュー構成
  - ヒーローイメージの有無・サイズ
  - メインメッセージの位置・文字数
  - CTAボタンの位置・サイズ・色・テキスト
- レイアウトパターン
  - グリッドシステム（1カラム、2カラム等）
  - 余白の使い方
  - フォントサイズ・行間
- インタラクション要素
  - ボタン数・種類
  - フォーム項目数
  - ナビゲーション構造

**【コンテンツデータ】**

- テキスト量（文字数）
- 見出し構造（H1-H6）
- 画像数・種類
- 動画の有無
- 社会的証明（レビュー、事例、実績数値）

**【技術データ】**

- 使用技術スタック
- ページ読み込み速度
- モバイル対応度
- アクセシビリティスコア

**【SEOデータ】**

- メタタグ（title, description）
- 構造化データ
- OGPタグ
- キーワード密度

**【競合データ】**

- 同業界サイトのパターン
- トレンド変化（時系列）
- ランキング上位サイトの特徴

#### 3.2.2 クローラーデータの更新頻度

- **自社サイト**: リアルタイム（変更検知時）
- **競合サイト**: 週次
- **業界ベンチマーク**: 月次
- **トレンド分析**: 四半期

#### 3.2.3 linkscrawl統合実装

**【実装場所】**

- `lib/crawler/` - linkscrawl統合モジュール（新規作成）
- `app/api/crawler/` - クローラーAPI（新規作成）
- `lib/crawler/linkscrawl-client.ts` - linkscrawlクライアント

**【統合方法】**

```typescript
// lib/crawler/linkscrawl-client.ts
import { LinkscrawlClient } from '@linkth/linkscrawl';

export class HeatClickCrawler {
  private client: LinkscrawlClient;
  
  async crawlSite(url: string) {
    // linkscrawlを使用してサイトをクロール
    // データをHeatClick形式に変換
    // データベースに保存
  }
  
  async compareWithCompetitors(siteId: string) {
    // 競合サイトとの比較分析
  }
}
```

### 3.3 データ前処理

#### 3.3.1 クレンジング処理

- **ボット除外**: 異常な速度、パターンでの操作を除外
- **テストトラフィック除外**: 開発者の動作を除外
- **スパム除外**: 明らかに不正なデータを除外
- **重複除外**: 同一イベントの重複を削除

#### 3.3.2 正規化処理

- **座標の正規化**: 画面サイズで割って0-1に正規化
- **時刻の正規化**: タイムゾーン統一
- **テキストの正規化**: 全角/半角統一、小文字化

#### 3.3.3 特徴量エンジニアリング

- **派生特徴量の生成**
  - クリック密度（エリアあたりのクリック数）
  - 平均滞在時間
  - 離脱率
  - ページ深度
  - セッション中の平均ページビュー
  - コンバージョンまでの時間

---

## 4. AI分析層の仕様

### 4.1 RAGシステム詳細仕様

#### 4.1.1 知識ベースの構成

**【カテゴリ1: 実案件データ】**

- データ源: 10-20社の過去案件
- 内容:
  - 案件概要（業界、サイト規模、課題）
  - 実施した施策（詳細）
  - 結果（CVR変化、売上影響）
  - 学び・気づき
- 形式: JSON + 自然言語説明
- 更新: 月次（新規案件完了時）

**【カテゴリ2: 業界ベストプラクティス】**

- データ源: 公開情報、学術論文、業界レポート
- 内容:
  - 業界別のUI/UXトレンド
  - CVR改善の定石
  - A/Bテスト結果（公開情報）
  - 消費者行動の研究結果
- 形式: マークダウン文書
- 更新: 四半期

**【カテゴリ3: linkscrawl分析結果】**

- データ源: linkscrawl統合
- 内容:
  - 業界トップサイトの特徴
  - 競合サイトの変更履歴
  - 業界平均値・中央値
  - トレンド分析
- 形式: 構造化データ + 自然言語サマリ
- 更新: 週次

**【カテゴリ4: UI/UXの理論】**

- データ源: 専門書籍、HCI研究
- 内容:
  - 視線誘導の原則
  - 色彩心理学
  - 認知負荷理論
  - フィッツの法則等
- 形式: マークダウン文書
- 更新: 半年

**【カテゴリ5: SEO知見】** ← 既存強み活用

- データ源: SEOコンサル知見
- 内容:
  - SEOとCROの関係
  - 検索意図別の最適UI
  - ランディングページ最適化
- 形式: ナレッジベース
- 更新: 月次

#### 4.1.2 ベクトルDB設計

**【使用技術】**

- Supabase pgvector（PostgreSQL拡張）
- 埋め込みモデル: OpenAI text-embedding-3-large

**【スキーマ】**

```sql
-- Supabase PostgreSQL
CREATE TABLE knowledge_base (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL, -- 'case', 'best_practice', 'crawler', 'theory', 'seo'
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(3072),
  metadata JSONB,
  -- metadata fields:
  --   industry (業界)
  --   site_type (EC, BtoB SaaS等)
  --   cvr_range (CVR範囲)
  --   traffic_range (月間PV範囲)
  --   success_metric (改善率)
  relevance_score FLOAT DEFAULT 0.0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX ON knowledge_base USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX ON knowledge_base (category);
CREATE INDEX ON knowledge_base (metadata);
```

#### 4.1.3 検索フロー

**【ステップ1: クエリ生成】**

- 入力: ユーザーサイトの状況
- 生成: 自然言語クエリ
- 例: 「BtoB SaaSサイトで、フォーム離脱率が高い場合の改善事例」

**【ステップ2: ベクトル検索】**

- クエリを埋め込みベクトル化
- コサイン類似度で上位K件取得（K=10）
- メタデータフィルタリング（業界、サイトタイプ等）

**【ステップ3: リランキング】**

- 取得した10件をrelevance_scoreで再ランク
- 実際の有用性を学習

**【ステップ4: コンテキスト構築】**

- 上位3-5件を選択
- Claude APIに渡すコンテキストを構築

#### 4.1.4 RAG実装場所

- `lib/rag/` - RAGシステムモジュール（新規作成）
  - `lib/rag/vector-store.ts` - ベクトルDB操作
  - `lib/rag/retriever.ts` - 検索・リランキング
  - `lib/rag/knowledge-base.ts` - 知識ベース管理
- `app/api/rag/` - RAG API（新規作成）
- 既存の `/app/ai-insights` ページを拡張

### 4.2 MLモデル群の詳細仕様

#### 4.2.1 クリック予測モデル

**【目的】**

このボタン・リンクがクリックされる確率を予測

**【アルゴリズム】**

- Phase 1: Gradient Boosting（LightGBM）
- Phase 2: ニューラルネット（PyTorch）

**【入力特徴量】**（約50次元）

- **視覚的特徴**
  - 位置（x, y座標の正規化）
  - サイズ（width × height）
  - 色（RGB、HSV）
  - コントラスト比
  - 余白量（上下左右）
- **テキスト特徴**
  - テキスト内容の埋め込み（BERT）
  - テキスト長
  - 緊急性ワード有無（「今すぐ」「限定」等）
  - 行動喚起ワード有無（「購入」「登録」等）
- **文脈特徴**
  - ページ内の位置（ファーストビュー内か）
  - 周辺要素数
  - 同じタイプの要素数
  - 視線誘導要素の有無（矢印、アニメーション）
- **ユーザー特徴**
  - デバイスタイプ
  - 流入元
  - セッション内の行動履歴
- **linkscrawl特徴** ← 独自
  - 業界平均クリック率
  - 競合サイトでの同様要素のCTR
  - トレンドスコア

**【出力】**

- クリック確率（0-1）
- 信頼区間

**【学習データ】**

- ポジティブ例: 実際にクリックされた要素
- ネガティブ例: 表示されたがクリックされなかった要素
- データ量: 初期10万件 → 継続的に増加

**【評価指標】**

- AUC-ROC
- Precision, Recall
- Calibration（確率の較正度）

#### 4.2.2 CVR予測モデル

**【目的】**

このセッションがコンバージョンする確率を予測

**【アルゴリズム】**

- LSTM + Attention（行動シーケンスのモデリング）

**【入力特徴量】**

- **行動シーケンス**
  - ページ閲覧順序（埋め込み）
  - 各ページの滞在時間
  - クリックパターン
  - スクロール深度
  - マウス移動の特徴
- **セッション特徴**
  - 流入元（広告、検索クエリ）
  - デバイス
  - 時間帯・曜日
  - 過去の訪問履歴
- **サイト特徴**（linkscrawlから）
  - サイト構造
  - コンテンツ量
  - UI品質スコア
- **ベンチマーク特徴**
  - 業界平均CVR
  - 類似サイトのCVR
  - 同じ流入元の平均CVR

**【出力】**

- CVR確率（0-1）
- リアルタイム更新（ページ遷移ごと）

**【学習データ】**

- ポジティブ例: コンバージョンしたセッション
- ネガティブ例: コンバージョンしなかったセッション
- データバランス調整（SMOTE等）

**【評価指標】**

- AUC-ROC
- Precision@K（上位K%の精度）
- Calibration

#### 4.2.3 セグメンテーションモデル

**【目的】**

ユーザーを行動パターンで自動分類

**【アルゴリズム】**

- K-means（初期）
- HDBSCAN（密度ベース、より柔軟）

**【入力特徴量】**

- セッション行動の埋め込み（LSTM encoderで生成）
- クリックパターンの特徴量
- 滞在時間分布
- ページ遷移パターン

**【出力】**

- セグメントID（例: 10セグメント）
- 各セグメントの特徴説明（Claude APIで生成）

**【セグメント例】**

1. 高購買意欲・短時間決定型
2. 情報収集・比較検討型
3. 価格重視・コスト意識型
4. 初回訪問・探索型
5. リピーター・ロイヤル顧客型
6. モバイル・流し読み型
7. 企業・BtoB購買型
8. 離脱リスク高型
9. 間違い流入型
10. 不正・ボット型

#### 4.2.4 異常検知モデル

**【目的】**

通常と異なるパターンを検知

**【アルゴリズム】**

- Isolation Forest
- Autoencoder（より高度）

**【検知対象】**

1. **ボット検知**
   - 異常に速いクリック
   - 規則的すぎる動き
   - JavaScriptの挙動異常
2. **バグ検知**
   - 特定要素のクリック率急減
   - エラーページへの遷移増加
   - フォーム送信失敗増加
3. **チャンス検知**
   - 通常より高いCVR
   - 新しいユーザーセグメント
   - 特定流入元の急増

**【出力】**

- 異常スコア（0-1）
- 異常タイプ
- アラート要否

#### 4.2.5 流入元別最適化モデル

**【目的】**

広告・検索クエリごとに最適なLP・UIを予測

**【アルゴリズム】**

- コンテキスト付き多腕バンディット

**【入力】**

- 流入元情報（UTM、クエリ等）
- ユーザー特徴
- 時間帯・曜日

**【出力】**

- 最適なLPバリエーション
- 最適なCTAテキスト
- 最適な表示コンテンツ順序

**【学習】**

- オンライン学習（リアルタイム）
- Explore/Exploit のバランス（ε-greedy）

#### 4.2.6 ML実装場所

**【Python MLサービス】**

- `ml-service/` - MLモデル管理サービス（新規作成）
  - `ml-service/models/` - モデル定義
  - `ml-service/training/` - 学習スクリプト
  - `ml-service/inference/` - 推論API
- `ml-service/api/` - FastAPI推論サーバー

**【Next.js統合】**

- `lib/ml/` - ML APIクライアント（新規作成）
- `app/api/ml/` - ML推論API（新規作成）

### 4.3 Claude API統合仕様（既存機能拡張）

#### 4.3.1 使用モデル

- claude-sonnet-4-20250514（既存）
- プロンプトキャッシング有効化（コスト削減）

#### 4.3.2 統合分析フロー

**【入力】**

```typescript
{
  site_data: {
    url: "example.com",
    industry: "BtoB SaaS",
    monthly_pv: 50000,
    current_cvr: 2.3
  },
  heatmap_data: {
    low_click_elements: [...],
    high_exit_pages: [...]
  },
  ml_predictions: {
    click_predictions: [...],
    cvr_predictions: [...],
    segments: [...]
  },
  rag_context: {
    similar_cases: [...],
    best_practices: [...]
  },
  crawler_data: {
    competitor_comparison: [...],
    industry_benchmark: [...]
  }
}
```

**【プロンプト構造】**

```
System Prompt（キャッシュ済み）:
- あなたはCRO専門家
- 10年の経験
- データドリブンな分析
- 具体的な改善提案

User Prompt:
- 現状分析の依頼
- 全データの提供
- 出力形式の指定（JSON）
```

**【出力】**

```typescript
{
  executive_summary: "3行サマリ",
  root_causes: [
    {
      issue: "CTAボタンのクリック率が低い",
      why: "色のコントラストが不足",
      evidence: "ML予測では15%のクリックが期待されるが、実際は8%",
      industry_context: "同業界では平均18%"
    }
  ],
  recommendations: [
    {
      priority: "高",
      action: "CTAボタンの色を#FF5733に変更",
      reason: "過去5社で平均+22%の改善",
      expected_impact: {
        cvr_change: "+0.5%",
        revenue_change: "+50万円/月",
        confidence: "85%"
      },
      effort: "1時間",
      implementation: "CSSコード付き"
    }
  ],
  ab_test_plan: [...],
  risk_alerts: [...]
}
```

#### 4.3.3 既存AI分析ページの拡張

既存の `/app/ai-insights` ページを拡張：

- RAGコンテキスト統合
- ML予測結果の表示
- linkscrawl比較データの表示
- より詳細な改善提案

---

## 5. 機能詳細仕様

### 5.1 ダッシュボード機能（既存機能拡張）

#### 5.1.1 メインダッシュボード

**【既存表示項目】**

- KPIカード表示（総クリック数、クリック率、平均滞在時間、直帰率）
- トップクリック要素ランキング
- 検索クエリ別パフォーマンス

**【追加表示項目】**

- **リアルタイムメトリクス**（5秒更新）
  - 現在の訪問者数
  - 本日のコンバージョン数
  - リアルタイムCVR
  - 高確度訪問者アラート
- **AI インサイトカード**
  - 今日の注目すべき変化
  - 今すぐ対応すべき問題
  - チャンス発見
- **予測グラフ**
  - 今月の売上予測
  - CVR トレンド予測
  - A/Bテスト効果予測

#### 5.1.2 ヒートマップビュー（既存機能拡張）

**【既存ヒートマップ】**

- クリックヒートマップ
- スクロールヒートマップ

**【AI強化ヒートマップ】** ← 新規

- **予測ヒートマップ**
  - 「本来クリックされるべき箇所」を表示
  - 実際のヒートマップとの差分を可視化
- **セグメント別ヒートマップ**
  - 10セグメントごとに異なるヒートマップ
  - セグメント切り替え機能
- **流入元別ヒートマップ** ← 既存機能の拡張
  - 広告別
  - 検索クエリ別
  - リファラー別
- **時系列ヒートマップ**
  - 訪問後0-30秒、30-60秒等で区切る
  - 時間経過での行動変化を可視化
- **競合比較ヒートマップ** ← 独自（linkscrawl統合）
  - 競合サイトのヒートマップ（推定）
  - 自社との差分表示

**【インタラクティブ機能】**

- 要素クリックで詳細情報表示
  - 実際のクリック数・率
  - ML予測クリック率
  - 改善提案
  - 類似サイトの事例

### 5.2 改善提案機能（既存機能拡張）

#### 5.2.1 自動診断

**【診断項目】**（100項目以上）

- UI/UX診断
  - ファーストビューの最適化
  - CTA配置・デザイン
  - フォーム最適化
  - ナビゲーション
  - モバイル最適化
- コンテンツ診断
  - 社会的証明の有無
  - 価値提案の明確さ
  - テキスト量の適切さ
- テクニカル診断
  - ページ速度
  - エラーページ
  - ブラウザ互換性
- 競合比較診断（linkscrawl統合）
  - 業界平均との差
  - トップサイトとの差

**【診断フロー】**

```
1. MLモデルで定量分析
   ↓
2. RAGで類似事例検索
   ↓
3. linkscrawlで競合比較
   ↓
4. Claude APIで統合診断
   ↓
5. 優先順位付き改善案リスト生成
```

#### 5.2.2 改善提案の詳細

**【提案フォーマット】**

```typescript
{
  priority: "高/中/低",
  category: "UI/コンテンツ/テクニカル",
  issue: "問題の説明",
  why: "なぜ問題なのか（根拠）",
  evidence: {
    ml_prediction: "ML予測結果",
    current_metric: "現在の数値",
    benchmark: "業界平均",
    similar_case: "類似事例"
  },
  recommendation: "具体的な改善案",
  expected_impact: {
    cvr_change: "+0.5%",
    revenue_change: "+50万円/月",
    confidence: "85%"
  },
  implementation: {
    effort: "2時間",
    cost: "0円",
    code: "実装コード（該当する場合）",
    steps: ["手順1", "手順2"]
  }
}
```

### 5.3 アラート機能（新規）

#### 5.3.1 リアルタイムアラート

**【アラートタイプ】**

- **高確度ユーザー検知**
  - CVR予測 > 80%のユーザーが訪問中
  - → 営業チームに通知
- **異常検知**
  - CVRが通常の50%以下に低下
  - 特定ページの離脱率急増
  - → 管理者に即座に通知
- **チャンス発見**
  - 特定流入元のCVRが通常の2倍
  - 新しい高CVRセグメント発見
  - → マーケティング担当に通知

**【通知方法】**

- ダッシュボード内通知
- メール
- Slack連携
- Webhook（カスタム連携）

### 5.4 セグメント分析機能（新規）

**【セグメント自動生成】**

- 10-20の行動パターンセグメント
- 各セグメントの自動命名・説明
- セグメントサイズ・CVR

**【セグメント別分析】**

- ヒートマップ
- ユーザージャーニー
- 推奨改善策
- パーソナライゼーション提案

### 5.5 競合分析機能（新規・linkscrawl統合）

**【競合モニタリング】**

- 登録した競合サイトを週次クロール
- UI変更を自動検知
- 変更内容の分析
- 自社への影響予測

**【業界ベンチマーク】**

- 業界平均との比較（50項目以上）
- ランキング表示
- ギャップ分析
- 改善優先順位

**【トレンド分析】**

- 業界全体のUIトレンド
- 新しいパターンの発見
- 採用推奨度

---

## 6. データベース設計

### 6.1 主要テーブル

#### 6.1.1 sites（サイト管理） - 既存拡張

```sql
-- PostgreSQL (Supabase)
CREATE TABLE sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  domain TEXT NOT NULL,
  industry TEXT,
  site_type TEXT, -- EC, BtoB, メディア等
  tracking_code TEXT,
  settings JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

#### 6.1.2 events（イベントデータ） - ClickHouse

```sql
-- ClickHouse
CREATE TABLE events (
  event_id UUID,
  site_id UUID,
  session_id UUID,
  user_id UUID,
  event_type TEXT, -- click, scroll, mousemove等
  timestamp DateTime64(3),
  page_url TEXT,
  element_data JSON,
  position JSON, -- 座標
  device_info JSON,
  referrer_info JSON,
  utm_params JSON,
  search_query TEXT
) ENGINE = MergeTree()
ORDER BY (site_id, timestamp, session_id);
```

#### 6.1.3 sessions（セッション集約） - PostgreSQL

```sql
-- PostgreSQL (Supabase)
CREATE TABLE sessions (
  session_id UUID PRIMARY KEY,
  site_id UUID REFERENCES sites(id),
  user_id UUID,
  start_time TIMESTAMP,
  end_time TIMESTAMP,
  duration INTEGER, -- 秒
  page_views INTEGER,
  events_count INTEGER,
  device_type TEXT,
  referrer_type TEXT, -- ad, organic, direct等
  utm_params JSONB,
  search_query TEXT,
  landing_page TEXT,
  exit_page TEXT,
  converted BOOLEAN,
  conversion_type TEXT,
  conversion_value DECIMAL,
  segment_id INTEGER,
  cvr_prediction FLOAT, -- ML予測
  anomaly_score FLOAT
);
```

#### 6.1.4 heatmap_data（ヒートマップ集約） - ClickHouse

```sql
-- ClickHouse
CREATE TABLE heatmap_data (
  id UUID,
  site_id UUID,
  page_url TEXT,
  date DATE,
  device_type TEXT,
  referrer_type TEXT,
  click_data JSON,
  scroll_data JSON,
  aggregated_metrics JSON
) ENGINE = MergeTree()
ORDER BY (site_id, page_url, date);
```

#### 6.1.5 ml_predictions（ML予測結果） - PostgreSQL

```sql
-- PostgreSQL (Supabase)
CREATE TABLE ml_predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID REFERENCES sites(id),
  prediction_type TEXT, -- click, cvr, segment等
  input_data JSONB,
  prediction JSONB,
  confidence FLOAT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

#### 6.1.6 crawler_data（linkscrawlデータ） - PostgreSQL

```sql
-- PostgreSQL (Supabase)
CREATE TABLE crawler_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID REFERENCES sites(id),
  target_site TEXT, -- 分析対象サイト
  crawl_date DATE,
  site_structure JSONB,
  ui_features JSONB,
  content_features JSONB,
  tech_features JSONB,
  performance_metrics JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
```

#### 6.1.7 knowledge_base（RAG） - Supabase pgvector

```sql
-- PostgreSQL (Supabase) - 既に4.1.2で定義済み
-- pgvector拡張を使用
```

#### 6.1.8 recommendations（改善提案） - PostgreSQL

```sql
-- PostgreSQL (Supabase)
CREATE TABLE recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID REFERENCES sites(id),
  generated_at TIMESTAMP DEFAULT NOW(),
  priority TEXT,
  category TEXT,
  issue TEXT,
  recommendation TEXT,
  expected_impact JSONB,
  implementation JSONB,
  status TEXT, -- pending, implemented, dismissed
  actual_impact JSONB -- 実施後の実測値
);
```

---

## 7. 技術スタック

### 7.1 フロントエンド（既存）

- **Framework**: Next.js 14（App Router）
- **UI**: TailwindCSS + shadcn/ui
- **状態管理**: Zustand
- **データ取得**: React Query（将来追加）
- **グラフ**: Recharts
- **ヒートマップ表示**: heatmap.js

### 7.2 バックエンド（既存 + 拡張）

- **API**: Next.js API Routes
- **認証**: Supabase Auth（将来追加）
- **リアルタイム処理**: Redis Streams
- **バッチ処理**: Python (Celery) ← 新規
- **ML**: Python (scikit-learn, PyTorch) ← 新規

### 7.3 インフラ（既存）

- **ホスティング**: Vercel（Next.js）
- **データベース**:
  - PostgreSQL（Supabase）: メタデータ、集約データ、ベクトルDB
  - ClickHouse（Hetzner）: 時系列イベントデータ
  - Redis（Hetzner）: キャッシュ、セッション、リアルタイム処理
- **ストレージ**: Hetzner Object Storage（ログ、録画データ）
- **ML実行環境**: 
  - AWS Lambda（推論）または自社サーバー
  - Hetzner Cloud（学習・バッチ処理）← 新規

### 7.4 外部API（既存 + 拡張）

- **LLM**: Claude API (Anthropic) - 既存
- **埋め込み**: OpenAI Embeddings API ← 新規
- **広告データ**: Google Ads API - 既存
- **検索データ**: Google Search Console API - 既存
- **クローラー**: linkscrawl（linkth/linkscrawl）← 新規統合

### 7.5 監視・分析（将来追加）

- **エラー追跡**: Sentry
- **ログ**: CloudWatch Logs または Hetzner Logs
- **メトリクス**: Prometheus + Grafana
- **アラート**: PagerDuty または Slack

---

## 8. 実装ロードマップ

### 8.1 Phase 1: MVP拡張（3-4ヶ月）

**【Month 1: 基盤構築】**

- Week 1-2: データベース統合
  - ClickHouseとの実際の接続
  - Redisキャッシュの実装
  - データ永続化の実装
- Week 3-4: linkscrawl統合準備
  - linkscrawlクライアント実装
  - クローラーAPI開発
  - データ変換ロジック

**【Month 2: RAGシステム構築】**

- Week 1-2: RAGシステム構築
  - 知識ベース構築（10案件分）
  - ベクトルDB実装（Supabase pgvector）
  - 検索機能実装
- Week 3-4: Claude API統合拡張
  - RAGコンテキスト統合
  - プロンプト最適化
  - 改善提案生成の強化

**【Month 3: データ収集拡張】**

- Week 1-2: トラッキングスクリプト拡張
  - 追加イベント収集実装
  - コンバージョン追跡実装
- Week 3-4: linkscrawl統合完了
  - 競合サイトクロール実装
  - 業界ベンチマーク取得
  - データ統合

**【Month 4: UI実装・テスト】**

- Week 1-2: ダッシュボード拡張
  - ML予測表示（プレースホルダー）
  - 競合分析表示
  - AIインサイトカード
- Week 3-4: テスト・修正
  - 統合テスト
  - パフォーマンス最適化
  - バグ修正

**【Phase 1機能】**

- ✅ ヒートマップ表示（既存）
- ✅ 流入元別分析（既存）
- ✅ RAGベースの改善提案（新規）
- ✅ linkscrawl統合（新規）
- ✅ 競合分析（新規）
- ❌ ML予測（Phase 2）
- ❌ セグメント分析（Phase 2）

**【収益化】**

- 既存クライアント3-5社でβテスト
- 料金: 月3-5万円
- 目標: 5社契約（月15-25万円）

### 8.2 Phase 2: ML追加（6-9ヶ月）

**【Month 5-6: データ蓄積・ML準備】**

- データ収集継続（最低10万イベント必要）
- ML環境セットアップ
  - Python MLサービス構築
  - 特徴量エンジニアリング設計
  - 学習パイプライン構築

**【Month 7-8: MLモデル開発】**

- クリック予測モデル
  - データ準備
  - モデル学習
  - 評価・チューニング
  - API化
- CVR予測モデル
  - シーケンスデータ準備
  - LSTMモデル実装
  - 学習・評価
  - リアルタイム推論実装

**【Month 9: 統合・UI実装】**

- 予測機能のダッシュボード統合
- セグメント分析機能
- 異常検知・アラート
- 精度改善・チューニング

**【Phase 2機能】**

- ✅ クリック予測
- ✅ CVR予測
- ✅ セグメント分析
- ✅ 異常検知
- ✅ ML強化ヒートマップ

**【収益化】**

- 10社に展開
- 料金: 月5-7万円
- 目標: 20社契約（月100-140万円）

### 8.3 Phase 3: 自動最適化（12-18ヶ月）

**【Month 10-12: 高度なML】**

- 多腕バンディット実装
- オンライン学習システム
- A/Bテスト自動化
- パーソナライゼーション

**【Month 13-15: エンタープライズ機能】**

- API提供
- カスタムモデル学習
- ホワイトラベル対応
- 大規模対応（1億PV/月）

**【Phase 3機能】**

- ✅ A/Bテスト自動化
- ✅ リアルタイム最適化
- ✅ エンタープライズAPI
- ✅ パーソナライゼーション

**【収益化】**

- 50社に展開
- 料金: 月7-20万円（プランによる）
- 目標: 月500-800万円

---

## 9. KPI・成果指標

### 9.1 プロダクトKPI

**【利用指標】**

- DAU/MAU（アクティブユーザー）
- 週次ログイン率
- 機能別利用率
- セッション時間

**【価値指標】**

- 顧客のCVR改善率（平均）
- 顧客の売上増加額（平均）
- 改善提案の実施率
- 改善提案の成功率

**【技術指標】**

- ML予測精度（AUC）
  - Phase 2: クリック予測 AUC 0.80、CVR予測 AUC 0.75
  - Phase 3: クリック予測 AUC 0.85+、CVR予測 AUC 0.82+
- レスポンス速度
- エラー率
- データ処理量

### 9.2 ビジネスKPI

**【収益指標】**

- MRR（月次経常収益）
- ARR（年次経常収益）
- 顧客単価（ARPU）
- 顧客生涯価値（LTV）

**【成長指標】**

- 新規顧客獲得数
- 解約率（Churn Rate）
- ネットリテンション率
- アップセル率

**【目標（18ヶ月後）】**

- 顧客数: 50社
- MRR: 500-800万円
- 平均顧客CVR改善: +30%
- 解約率: <5%

### 9.3 ML精度目標

| モデル | Phase 1 | Phase 2 | Phase 3 |
|--------|---------|---------|---------|
| クリック予測 | - | AUC 0.80 | AUC 0.85+ |
| CVR予測 | - | AUC 0.75 | AUC 0.82+ |
| セグメント精度 | - | 70% | 85%+ |
| 異常検知 | - | F1 0.70 | F1 0.80+ |

---

## 10. リスクと対策

### 10.1 技術リスク

**【リスク1: MLモデルの精度不足】**

- 対策: Phase 1でRAGのみで価値提供、データ蓄積
- 対策: linkscrawlデータで転移学習活用

**【リスク2: スケーラビリティ】**

- 対策: ClickHouseで時系列データ処理
- 対策: Redis Streamsでリアルタイム処理
- 対策: 段階的なインフラ拡張

**【リスク3: Claude APIコスト】**

- 対策: プロンプトキャッシング活用（90%削減）
- 対策: バッチ処理で効率化
- 対策: 料金に転嫁

**【リスク4: linkscrawl統合の複雑さ】**

- 対策: 段階的な統合（まずAPI連携、後で直接統合）
- 対策: エラーハンドリングの充実
- 対策: フォールバック機能

### 10.2 ビジネスリスク

**【リスク1: 顧客獲得の遅れ】**

- 対策: 既存クライアントからの紹介
- 対策: 早期βテストでの価値実証

**【リスク2: 競合の参入】**

- 対策: linkscrawl統合による差別化
- 対策: SEO特化による専門性
- 対策: ネットワーク効果の構築

---

## 11. 次のアクション

### 優先度: 高（即座に着手）

1. **データベース統合**
   - [ ] ClickHouseとの実際の接続
   - [ ] Redisキャッシュの実装
   - [ ] Supabase pgvector拡張の有効化

2. **linkscrawl統合準備**
   - [ ] linkscrawlフォルダの構造確認
   - [ ] linkscrawlクライアント実装
   - [ ] クローラーAPI設計

3. **RAG知識ベース構築**
   - [ ] 実案件データの収集
   - [ ] 知識ベーススキーマ設計
   - [ ] ベクトル埋め込み実装

### 優先度: 中（1-2ヶ月以内）

4. **ML環境準備**
   - [ ] Python MLサービス設計
   - [ ] 学習環境セットアップ
   - [ ] 特徴量エンジニアリング設計

5. **UI拡張**
   - [ ] ダッシュボード拡張
   - [ ] 競合分析ページ作成
   - [ ] セグメント分析ページ作成

---

**最終更新**: 2025年1月25日  
**バージョン**: 1.0  
**作成者**: AI Assistant (Claude)


