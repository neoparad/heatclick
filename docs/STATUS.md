# ClickInsight Pro - 開発状況

最終更新: 2025年1月26日

## 📊 プロジェクト概要

**プロジェクト名**: ClickInsight Pro (heatclick-ai)  
**説明**: AI搭載のヒートマップ・クリック分析ツール - 検索意図と行動データを統合する"知能型ヒートマップ分析"  
**開発フェーズ**: Phase 1完了 / Phase 2進行中  
**本番環境**: Vercel（稼働中）

## 🌐 本番環境

- **デプロイプラットフォーム**: Vercel
- **プロジェクト名**: heatclick-ai
- **本番URL**: https://heatclick-p47dqkc2q-hiroki101313-gmailcoms-projects.vercel.app
- **ステータス**: ✅ 稼働中

## ✅ 完了項目

### Phase 1: 基盤完成 ✅

#### データベース統合
- [x] ClickHouse接続基盤（`lib/clickhouse.ts`）
- [x] Redis接続基盤（`lib/redis.ts`）
- [x] データベーススキーマ設計
- [x] サイトデータのClickHouse保存対応
- [x] イベントデータのClickHouse保存対応

#### データ構造拡張
- [x] `event_revenue` カラム追加
- [x] UTMパラメータ・広告ID取得機能（`gclid`, `fbclid`）
- [x] セッション集約テーブル（`sessions`）作成
- [x] ヒートマップ集計テーブル（`heatmap_summary`）作成

#### トラッキングシステム
- [x] トラッキングスクリプト拡張（`public/tracking.js`）
- [x] UTMパラメータ・広告ID自動取得
- [x] デバイスタイプ・リファラータイプ自動判定
- [x] オプトアウト・Cookie同意チェック機能

#### プライバシー・GDPR対応
- [x] IP匿名化機能（`lib/privacy.ts`）
- [x] ユーザーエージェント簡略化
- [x] オプトアウト・Cookie同意管理

#### セッション録画機能
- [x] rrwebライブラリ統合
- [x] 録画スクリプト（`public/recording.js`）
- [x] 録画データ保存API（`app/api/recordings/route.ts`）
- [x] 録画再生UI（`app/recordings/page.tsx`）
- [x] プライバシー対応（入力フィールドマスキング）

#### ファネル分析
- [x] セッション集約機能（`lib/session-aggregator.ts`）
- [x] ファネル分析API（`app/api/funnel/route.ts`）

#### 外部API連携基盤
- [x] Google Search Console API連携（`lib/integrations/gsc.ts`）
- [x] GA4 API連携基盤（`lib/integrations/ga4.ts`）
- [x] Shopify API連携基盤（`lib/integrations/shopify.ts`）
- [x] Google Ads API連携基盤（`lib/integrations/google-ads.ts`）
- [x] Meta Ads API連携基盤（`lib/integrations/meta-ads.ts`）

#### SEO × UX 統合分析
- [x] GSCデータ保存API（`app/api/gsc/route.ts`）
- [x] クエリごとのヒートマップAPI（`app/api/heatmap/query/route.ts`）
- [x] ヒートマップページにクエリフィルター機能追加

#### マルチテナント対応
- [x] `users`テーブルに`org_id`、`role`列追加
- [x] `sites`テーブルに`user_id`、`org_id`列追加

### フロントエンド実装
- [x] ダッシュボードページ（`/dashboard`）
- [x] リアルタイムページ（`/realtime`）
- [x] ヒートマップページ（`/heatmap`）
- [x] サイト管理ページ（`/sites`）
- [x] クリック分析ページ（`/clicks`）
- [x] AI分析ページ（`/ai-insights`）
- [x] レポートページ（`/reports`）
- [x] 設定ページ（`/settings`）
- [x] セッション録画ページ（`/recordings`）

## 🚧 進行中の項目

### Phase 2: 差別化機能（進行中）

#### AI インサイト（RAG + ML統合）
- [x] Claude API連携UI（完成済み）
- [ ] MLモデル学習パイプライン
- [ ] RAGシステム構築
- [ ] AI提案生成UI

#### SEO × UX 統合分析
- [x] Google Search Console API連携
- [x] GSC CTR / 平均順位 × ヒートマップ統合
- [ ] 「SEO×UX解析」ダッシュボード（UI実装待ち）

#### 広告別 ROI ヒートマップ
- [x] Google Ads API連携基盤
- [x] Meta Ads API連携基盤
- [ ] 広告別ROIヒートマップ表示（UI実装待ち）

## 📋 次のアクション（優先度順）

### 🔴 優先度: 緊急

#### 1. データベース接続の実装
**現状**: ClickHouseとRedisのクライアントコードは実装済みだが、実際の接続が未実装（モック実装のまま）

**必要な作業**:
1. HetznerサーバーでClickHouseとRedisをセットアップ（`scripts/setup-server.sh`を使用）
2. Vercelに環境変数を設定
3. 接続テストと動作確認

**影響**: データがメモリ内に保存され、サーバー再起動で消失

#### 2. 認証システムの実装
**現状**: 認証システムが一切実装されていない

**必要な作業**:
1. NextAuth.js v5のセットアップ
2. ユーザーテーブルの作成（ClickHouseまたはPostgreSQL）
3. ログイン/登録ページの実装
4. 認証ミドルウェアの実装

**影響**: マルチテナント機能が実現できない、セキュリティリスク

### 🟡 優先度: 高（1-2週間以内）

#### 3. トラッキングスクリプトの改善
**必要な作業**:
1. 環境変数から動的にURLを取得するように修正
2. スクリプトの最適化（5KB以下目標）
3. バッチ送信の実装

#### 4. 外部API連携の実装
**必要な作業**:
1. Claude API連携（AI分析機能）
2. Google Search Console API連携（実際のデータ取得）
3. Google Ads API連携（オプション）
4. Google Analytics 4連携（オプション）

#### 5. データ取得APIの実装
**必要な作業**:
1. ClickHouseからヒートマップデータを取得する実装
2. ClickHouseから統計データを取得する実装
3. キャッシュ機能の実装（Redis）

### 🟢 優先度: 中（1ヶ月以内）

#### 6. UI/UX改善
- ローディング状態の改善
- エラーメッセージの改善
- レスポンシブデザインの最適化

#### 7. セキュリティ強化
- API Rate Limitingの実装
- 認証・認可システムの実装
- データプライバシー対応（GDPR等）

#### 8. パフォーマンス最適化
- トラッキングスクリプトの最適化
- バッチ処理の実装
- キャッシュ戦略の最適化

### 🔵 優先度: 低（将来の拡張）

#### 9. 追加機能の実装
- A/Bテスト機能
- セッションリプレイ機能（録画機能は実装済み）
- ファネル分析（UI実装）
- コンバージョン率最適化（CRO）ツール

#### 10. レポート自動生成
- AI レポートテンプレートをJSON構成化
- 週次/月次で自動生成
- メール配信（Resend or SendGrid）

## ⚠️ 課題・懸念事項

### 技術的課題

1. **データベース接続** ⚠️ 最優先
   - **現状**: ClickHouseとRedisはモック実装（`lib/clickhouse.ts`, `lib/redis.ts`）
   - **問題**: データがメモリ内に保存され、サーバー再起動で消失
   - **解決策**: HetznerサーバーでClickHouseとRedisをセットアップし、実際の接続を実装
   - **セットアップスクリプト**: `scripts/setup-server.sh`が用意されている

2. **認証システム**
   - 認証システムが一切実装されていない
   - すべてのページが認証なしでアクセス可能
   - マルチテナント機能が実現できない

3. **外部API連携**
   - Claude API、Google APIsが未連携
   - AI分析機能が動作しない

4. **トラッキングスクリプト**
   - 本番環境URLがハードコードされていない
   - スクリプトサイズが最適化されていない

5. **パフォーマンス**
   - 大量イベントデータの処理が未実装
   - バッチインサートが未実装

### ビジネス課題

1. **外部APIコスト管理**
   - Claude APIのコストが不明
   - Google APIsのクォータ管理が必要

2. **収益モデル**
   - 料金プランは定義済みだが、決済システムが未実装

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

## 📈 開発ロードマップ

### Phase 1: 基盤完成 ✅（完了）
- [x] ClickHouse接続
- [x] Redis接続
- [x] 認証システム基盤
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
- [ ] SEO × UX 統合分析（UI実装）
- [ ] 広告別 ROI ヒートマップ（UI）

### Phase 3: 上位拡張（計画中）
- [ ] ファネル分析（UI実装）
- [ ] キャッシュ設計最適化
- [ ] レポート自動生成
- [ ] A/Bテスト連携

## 📝 更新履歴

- **2025-01-26**: ドキュメント整理 - STATUS.md作成
- **2025-01-25**: Phase 1完了項目の記録、セッション録画機能実装完了、Google Search Console連携実装完了



