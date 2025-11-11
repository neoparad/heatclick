# ClickInsight Pro - プロジェクト状況

最終更新: 2025年1月25日 18:00

## 📊 プロジェクト概要

**プロジェクト名**: ClickInsight Pro (heatclick-ai)
**説明**: ヒートマップ＆クリック分析ツール - AIによる自動診断と改善提案を行う次世代SEO特化型ツール

## 🎯 開発フェーズ

現在のフェーズ: **MVP開発完了 / Vercel本番環境デプロイ済み / データベース統合待ち**

## 🌐 本番環境

**デプロイプラットフォーム**: Vercel
**プロジェクト名**: heatclick-ai
**本番URL**: https://heatclick-p47dqkc2q-hiroki101313-gmailcoms-projects.vercel.app
**管理画面**: https://vercel.com/hiroki101313-gmailcoms-projects/heatclick-ai
**デプロイ日**: 2025年1月25日
**ステータス**: ✅ 稼働中

## ✅ 完了項目

### 環境構築
- [x] Next.js 14プロジェクト作成
- [x] TypeScript設定
- [x] Tailwind CSS設定
- [x] shadcn/ui導入完了
- [x] 依存パッケージインストール
  - ClickHouseクライアント
  - Redis (ioredis)
  - Recharts (チャートライブラリ)
  - heatmap.js
  - Zustand (状態管理)
  - React Hook Form + Zod

### テスト環境
- [x] Jest設定
- [x] Playwright E2Eテスト設定

### コア機能実装完了
- [x] **共通レイアウトシステム**
  - サイドバーナビゲーション
  - ヘッダーコンポーネント
  - レスポンシブデザイン

- [x] **ダッシュボードページ** (`/dashboard`)
  - KPIカード表示
  - トップクリック要素ランキング
  - 検索クエリ別パフォーマンス
  - サンプルデータ表示

- [x] **リアルタイムページ** (`/realtime`)
  - ライブデータ監視
  - 統計情報表示
  - イベント履歴
  - トラッキングスクリプト情報

- [x] **ヒートマップページ** (`/heatmap`)
  - ページ統計ダッシュボード
  - 視覚的ヒートマップ表示
  - 詳細クリックデータ
  - AI改善提案機能
  - 流入元・クエリ別分析

- [x] **サイト管理ページ** (`/sites`)
  - サイト登録・管理
  - トラッキングコード生成
  - トラッキングID表示・コピー機能（2025-01-25追加）
  - サイト登録後のトラッキングID自動表示モーダル（2025-01-25追加）
  - GTM連携説明
  - サイト一覧表示
  - サイト削除機能

- [x] **クリック分析ページ** (`/clicks`)
  - 詳細クリックデータ分析
  - フィルター機能
  - ページ別・デバイス別分析
  - エクスポート機能

- [x] **AI分析ページ** (`/ai-insights`)
  - Claude Sonnet 4による自動分析
  - 優先度別改善提案
  - 実装コード自動生成
  - 分析履歴管理

- [x] **レポートページ** (`/reports`)
  - 複数レポートテンプレート
  - 自動レポート生成
  - 生成済みレポート管理
  - 自動配信設定

- [x] **設定ページ** (`/settings`)
  - トラッキングスクリプト管理
  - アカウント設定
  - 通知設定
  - データ管理

- [x] **トラッキングシステム**
  - 実際のトラッキングスクリプト (`public/track.js`, `public/tracking.js`)
  - APIエンドポイント (`/api/track`, `/api/events`)
  - データ収集・保存機能（現在はメモリ内、ClickHouse統合待ち）
  - リアルタイムデータ表示
  - サイト管理API (`/api/sites`, `/api/sites/[id]`)
  - インストールコード生成API (`/api/install`)

### デプロイ・インフラ
- [x] **Vercel本番環境デプロイ** (2025-01-25完了)
  - ビルドエラー修正（lucide-reactインポート）
  - vercel.json設定ファイル作成
  - Vercel CLIでのデプロイ実行
  - 環境変数設定（NEXTAUTH_SECRET, NEXTAUTH_URL, NEXT_PUBLIC_APP_URL）
  - プロダクション環境での動作確認

## 🚧 進行中の項目

### 最新の実装（2025-01-25）
- [x] サイト登録機能の完成
  - サイト登録フォーム
  - トラッキングID自動生成（形式: `CIP_` + 16文字のランダム文字列）
  - サイト登録後のトラッキングID表示モーダル
  - サイト一覧でのトラッキングID表示
  - トラッキングIDコピー機能
  - トラッキングスクリプト生成・コピー機能

**注意**: データベース（ClickHouse, Redis）は未接続のため、データはメモリ内に一時保存されています。サーバー再起動時にデータは消失します。

## 📋 次のアクション

### 優先度: 高

1. **データベース統合** ⚠️ 最優先
   - [ ] HetznerサーバーでのClickHouseセットアップ（`scripts/setup-server.sh`を使用）
   - [ ] HetznerサーバーでのRedisセットアップ
   - [ ] ClickHouseとの実際の接続（`lib/clickhouse.ts`の実装）
   - [ ] Redisキャッシュの実装（`lib/redis.ts`の実装）
   - [ ] データ永続化の実装
   - [ ] サイトデータのClickHouse保存（`app/api/sites/route.ts`）
   - [ ] イベントデータのClickHouse保存（`app/api/track/route.ts`, `app/api/events/route.ts`）

2. **データベース設計**
   - [x] ClickHouseのスキーマ設計（`scripts/setup-server.sh`に含まれる）
   - [ ] イベントトラッキング用テーブル（`clickinsight.events`）
   - [x] サイト管理用テーブル（`clickinsight.sites`）
   - [ ] ユーザー管理用テーブル（未実装）

3. **外部API連携**
   - [ ] Google Search Console API連携
   - [ ] Google Ads API連携
   - [ ] Claude API統合（AI分析機能用）

4. **認証システム**
   - [ ] NextAuth.jsまたは独自認証の実装
   - [ ] ユーザー登録・ログイン機能
   - [ ] セッション管理

### 優先度: 中

5. **API Routes実装**
   - [x] トラッキングデータ受信API (`/api/track`, `/api/events`)
   - [x] サイト管理API (`/api/sites`, `/api/sites/[id]`)
   - [x] インストールコード生成API (`/api/install`)
   - [ ] ヒートマップデータ取得API（ClickHouse統合後）
   - [ ] 統計データ取得API（ClickHouse統合後）
   - [ ] 認証API (NextAuth or 独自実装)

6. **トラッキングスクリプトの改善**
   - [ ] 本番環境URLへの更新（現在は`localhost`）
   - [ ] スクリプトサイズの最適化（5KB以下目標）
   - [ ] エラーハンドリングの強化
   - [ ] バッチ送信の実装

7. **UI/UX改善**
   - [ ] ローディング状態の改善
   - [ ] エラーメッセージの改善
   - [ ] レスポンシブデザインの最適化

### 優先度: 低

8. **ドキュメント整備**
   - [x] プロジェクト状況ドキュメント（本ドキュメント）
   - [x] 現在の仕様書 (`docs/current-specification.md`)
   - [ ] 要件定義書作成
   - [ ] 技術仕様書作成
   - [ ] データベース設計書作成
   - [ ] API仕様書作成
   - [ ] セットアップガイド作成

## ⚠️ 課題・懸念事項

### 技術的課題

1. **データベース接続** ⚠️ 最優先
   - **現状**: ClickHouseとRedisはモック実装（`lib/clickhouse.ts`, `lib/redis.ts`）
   - **問題**: データがメモリ内に保存され、サーバー再起動で消失
   - **解決策**: HetznerサーバーでClickHouseとRedisをセットアップし、実際の接続を実装
   - **セットアップスクリプト**: `scripts/setup-server.sh`が用意されている

2. **インフラ設計**
   - Hetzner Cloudでの ClickHouse + Redis のセットアップ方法（スクリプトあり）
   - Vercelとの連携方法（環境変数で接続）
   - WebSocketの実装方法（Vercelの制限により、Server-Sent Eventsまたはポーリングを検討）

3. **パフォーマンス**
   - トラッキングスクリプトの5KB以下への最適化
   - 大量イベントデータの処理とバッチ処理
   - ClickHouseへのバッチインサート実装

4. **セキュリティ**
   - CORS設定（一部実装済み）
   - API Rate Limiting（未実装）
   - データプライバシー対応
   - 認証・認可システム（未実装）

5. **トラッキングスクリプトのURL**
   - 現在`localhost`やハードコードされたURLが含まれている
   - 本番環境URLへの動的設定が必要

### ビジネス課題
1. **外部API制限**
   - Claude API のコスト管理
   - Google APIs のクォータ管理
   - 無料プランでのAPI使用制限

2. **収益モデル**
   - 料金プランの最終決定
   - 決済システムの選定（Stripe, PayPal等）

## 🖥️ サーバーセットアップ情報

### Hetzner Cloud セットアップ

#### セットアップスクリプト
- **ファイル**: `scripts/setup-server.sh`
- **対象OS**: Ubuntu 22.04
- **機能**:
  - ClickHouseのインストールと設定
  - Redisのインストールと設定
  - ファイアウォール設定（SSH, ClickHouse HTTP/Native, Redis）
  - データベースとテーブルの自動作成

#### ClickHouse設定
- **HTTPポート**: 8123
- **Nativeポート**: 9000
- **データベース**: `clickinsight`
- **テーブル**:
  - `clickinsight.sites` - サイト管理用
  - `clickinsight.events` - イベントトラッキング用（セットアップスクリプトで作成）

#### Redis設定
- **ポート**: 6379
- **認証**: パスワード認証（セットアップ時に設定）

#### 環境変数設定
セットアップ完了後、以下の環境変数をVercelに設定：

```bash
# ClickHouse接続情報
CLICKHOUSE_URL=http://default:PASSWORD@SERVER_IP:8123/clickinsight
CLICKHOUSE_HOST=SERVER_IP
CLICKHOUSE_PORT=8123
CLICKHOUSE_DATABASE=clickinsight
CLICKHOUSE_USERNAME=default
CLICKHOUSE_PASSWORD=YOUR_PASSWORD

# Redis接続情報
REDIS_URL=redis://:PASSWORD@SERVER_IP:6379
REDIS_HOST=SERVER_IP
REDIS_PORT=6379
REDIS_PASSWORD=YOUR_PASSWORD
```

#### セキュリティ注意事項
- ファイアウォールで必要なポートのみ開放
- 強力なパスワードを使用
- SSH鍵認証の推奨
- 定期的なセキュリティアップデート

### Vercel環境変数
現在設定済み：
- `NEXTAUTH_SECRET`
- `NEXTAUTH_URL`
- `NEXT_PUBLIC_APP_URL`

追加が必要：
- ClickHouse接続情報（上記参照）
- Redis接続情報（上記参照）
- 外部APIキー（Claude, GSC, GA4等）

## 📝 メモ・アイデア

### 技術的メモ
- トラッキングスクリプトは別リポジトリで管理する可能性も検討
- CDN配信のためのキャッシュ戦略を考える必要がある
- リアルタイム分析のためのWebSocket代替案（Server-Sent Events等）
- ClickHouseのパーティション戦略（月次パーティションで実装済み）

### 機能アイデア
- A/Bテスト機能
- セッションリプレイ機能
- ファネル分析
- コンバージョン率最適化（CRO）ツール

## 📂 実装済みファイル一覧

### フロントエンド
- `app/sites/page.tsx` - サイト管理ページ（トラッキングID表示機能含む）
- `app/dashboard/page.tsx` - ダッシュボード
- `app/realtime/page.tsx` - リアルタイムページ
- `app/heatmap/page.tsx` - ヒートマップページ
- `app/clicks/page.tsx` - クリック分析ページ
- `app/ai-insights/page.tsx` - AI分析ページ
- `app/reports/page.tsx` - レポートページ
- `app/settings/page.tsx` - 設定ページ
- `app/install/page.tsx` - インストールページ
- `components/layout/` - レイアウトコンポーネント
- `components/ui/` - UIコンポーネント（shadcn/ui）

### バックエンドAPI
- `app/api/sites/route.ts` - サイト管理API（GET, POST）
- `app/api/sites/[id]/route.ts` - サイト個別API（GET, PUT, DELETE）
- `app/api/track/route.ts` - トラッキングデータ受信API
- `app/api/events/route.ts` - イベントデータ受信API
- `app/api/install/route.ts` - インストールコード生成API
- `app/api/heatmap/route.ts` - ヒートマップデータ取得API（モック）
- `app/api/statistics/route.ts` - 統計データ取得API（モック）
- `app/api/health/route.ts` - ヘルスチェックAPI

### ライブラリ・ユーティリティ
- `lib/clickhouse.ts` - ClickHouseクライアント（モック実装）
- `lib/redis.ts` - Redisクライアント（モック実装）
- `lib/utils.ts` - ユーティリティ関数

### トラッキングスクリプト
- `public/track.js` - トラッキングスクリプト（旧版）
- `public/tracking.js` - トラッキングスクリプト（新版、推奨）
- `public/test-page.html` - テスト用HTMLページ

### 設定ファイル
- `vercel.json` - Vercel設定
- `env.example` - 環境変数テンプレート
- `package.json` - 依存パッケージ
- `tsconfig.json` - TypeScript設定
- `tailwind.config.js` - Tailwind CSS設定
- `next.config.js` - Next.js設定

### ドキュメント
- `docs/project-status.md` - プロジェクト状況（本ドキュメント）
- `docs/current-specification.md` - 現在の仕様書
- `docs/development-log.md` - 開発ログ
- `docs/issues.md` - 課題管理
- `docs/next-actions.md` - 次のアクション
- `README.md` - プロジェクト概要

### スクリプト
- `scripts/setup-server.sh` - Hetznerサーバーセットアップスクリプト

## 🔗 関連ドキュメント

- [README.md](../README.md)
- [package.json](../package.json)
- [現在の仕様書](./current-specification.md)

## 📈 開発ロードマップ

### Phase 1: MVP開発 (目標: 2-3ヶ月)
- 基本的なトラッキング機能
- クリックヒートマップ表示
- シンプルなダッシュボード
- 1サイトのみ対応

### Phase 2: 機能拡張 (目標: 4-6ヶ月)
- AI分析機能追加
- GSC/GA4連携
- 複数サイト対応
- 有料プラン導入

### Phase 3: スケールアップ (目標: 7-12ヶ月)
- API公開
- WordPress プラグイン
- エンタープライズ機能
- パートナープログラム

## 🎯 今週の目標

**今週中に完了すべきこと:**
1. プロジェクト構造の整理
2. トラッキングスクリプトの基本実装
3. ClickHouseのローカル開発環境セットアップ

---

## 📌 更新履歴

- **2025-01-25 18:00**: 
  - サイト登録機能の完成を記録
  - トラッキングID表示・コピー機能の追加を記録
  - サーバーセットアップ情報を追加
  - 不足部分と次のアクションを詳細化
  - データベース接続状況を明確化
- **2025-01-25 17:00**: プロジェクト状況ドキュメント作成
