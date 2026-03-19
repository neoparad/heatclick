# ClickInsight Pro - 現在の接続状態と課題

**最終更新**: 2025年1月26日  
**作成者**: AI Assistant

---

## 📊 概要

このドキュメントは、ClickInsight Proの現在の接続状態、実装済み機能、残っている課題を包括的にまとめたものです。

---

## ✅ 実装済みの機能

### 1. ClickHouse接続機能

#### 実装状況: ✅ 完了

**実装内容**:
- ✅ ClickHouseクライアントの初期化機能
- ✅ 接続テスト機能 (`testClickHouseConnection()`)
- ✅ 接続状態確認機能 (`isClickHouseConnected()`)
- ✅ 接続リセット機能 (`resetClickHouseConnection()`)
- ✅ 定期的な接続テスト（1分ごと）
- ✅ 詳細なエラーハンドリング
- ✅ 環境変数の柔軟な設定（`CLICKHOUSE_URL`、個別設定の両方対応）
- ✅ 接続エラー時の自動リセット

**設定可能な環境変数**:
```env
# 方法1: 個別設定
CLICKHOUSE_HOST=localhost
CLICKHOUSE_PORT=8123
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=your_password
CLICKHOUSE_DATABASE=clickinsight

# 方法2: URL形式（優先）
CLICKHOUSE_URL=http://default:your_password@localhost:8123/clickinsight
```

**接続診断エンドポイント**:
- `/api/health` - 詳細な接続状態、環境変数、エラー情報を返す

### 2. 認証システム

#### 実装状況: ✅ 基本機能完了（データ同期の問題は解決済み）

**実装内容**:
- ✅ ユーザー登録API (`/api/auth/register`)
- ✅ ログインAPI (`/api/auth/login`)
- ✅ パスワードハッシュ化（bcrypt）
- ✅ メールアドレス形式バリデーション
- ✅ パスワード強度チェック（8文字以上）
- ✅ 既存ユーザーチェック
- ✅ ClickHouseへの保存機能（接続可能な場合）
- ✅ メモリ内ストレージへのフォールバック
- ✅ セッション管理（sessionStorage）
- ✅ **データ同期の問題は解決済み（2025年1月26日修正）**

**実装の詳細**:
- ✅ **ClickHouse接続可能な場合は、ClickHouseを優先**
  - ログイン時: ClickHouseから先に検索、接続不可時はメモリ内ストレージから検索
  - 登録時: ClickHouseで先に重複チェック、接続不可時はメモリ内ストレージでチェック
  - 保存時: ClickHouseに優先して保存、成功後メモリ内ストレージにも保存（キャッシュとして）
- ✅ **メモリ内ストレージはフォールバック/キャッシュとして使用**

**制限事項**:
- ⚠️ ClickHouse接続不可時はメモリ内ストレージのみ（サーバー再起動でデータ消失）
- ⚠️ マルチインスタンス環境では、メモリ内ストレージは共有されない（ClickHouse接続推奨）

### 3. Healthエンドポイント

#### 実装状況: ✅ 完了

**機能**:
- ✅ ClickHouse接続状態の確認
- ✅ 環境変数の確認（パスワードは非表示）
- ✅ エラー詳細の表示
- ✅ 推奨事項の提供

**エンドポイント**: `/api/health`

**レスポンス例**:
```json
{
  "status": "ok",
  "clickhouse": {
    "connected": true,
    "config": {
      "url": "http://localhost:8123",
      "database": "clickinsight",
      "username": "default"
    },
    "environment": {
      "CLICKHOUSE_HOST": "localhost",
      "CLICKHOUSE_PORT": "8123",
      "CLICKHOUSE_USER": "default",
      "CLICKHOUSE_PASSWORD": "***set***"
    }
  },
  "health": {
    "clickhouse": "healthy",
    "overall": "healthy"
  }
}
```

---

## ⚠️ 現在の課題

### 🔴 優先度: 緊急（即座に対応が必要）

#### 1. ClickHouseサーバーのセットアップ

**現状**:
- ✅ クライアントコードは実装済み
- ❌ 実際のClickHouseサーバーが未セットアップ
- ❌ 環境変数が未設定（Vercel）

**必要な作業**:
1. ClickHouseサーバーのセットアップ
   - Hetznerサーバーで`scripts/setup-server.sh`を実行
   - または、ClickHouse Cloudなどのマネージドサービスを使用
2. Vercelに環境変数を設定
   - Vercelダッシュボードで環境変数を設定
   - または、`vercel env add`コマンドで設定
3. 接続テスト
   - `/api/health`エンドポイントで接続確認

**影響**:
- データが永続化されない
- ユーザー登録データがサーバー再起動で消失
- トラッキングデータが保存されない

**解決策**:
```bash
# 1. ClickHouseサーバーをセットアップ
# Hetznerサーバーで実行
bash scripts/setup-server.sh

# 2. Vercelに環境変数を設定
vercel env add CLICKHOUSE_HOST production
vercel env add CLICKHOUSE_PORT production
vercel env add CLICKHOUSE_USER production
vercel env add CLICKHOUSE_PASSWORD production
vercel env add CLICKHOUSE_DATABASE production
```

#### 2. 認証データの永続化

**現状**:
- ✅ 認証APIは実装済み
- ✅ **データ同期の問題は解決済み（2025年1月26日修正）**
- ✅ ClickHouse接続可能な場合は、ClickHouseを優先
- ⚠️ ClickHouse接続不可時はメモリ内ストレージのみ（サーバー再起動でデータ消失）

**必要な作業**:
1. ClickHouseサーバーのセットアップ（上記参照）
2. `clickinsight.users`テーブルの作成確認
3. 接続テストと動作確認

**影響**:
- ✅ ClickHouse接続可能な場合: データは永続化され、サーバー再起動後もログイン可能
- ⚠️ ClickHouse接続不可時: メモリ内ストレージのみのため、サーバー再起動でデータ消失

#### 3. デプロイ状態

**現状**:
- ✅ 2025年1月25日にVercelにデプロイ済み
- ❌ 今回の修正（ClickHouse接続改善）は未デプロイ
- ❌ 環境変数が未設定

**必要な作業**:
1. 変更をコミット
   ```bash
   git add .
   git commit -m "Fix ClickHouse connection issues and improve authentication"
   ```
2. Vercelにプッシュ
   ```bash
   git push origin main
   ```
3. 環境変数を設定（上記参照）

---

### 🟡 優先度: 高（1-2週間以内）

#### 4. Redis接続の実装

**現状**:
- ✅ Redisクライアントコードは実装済み（`lib/redis.ts`）
- ❌ 実際のRedisサーバーが未セットアップ
- ⚠️ 接続失敗時はモック実装にフォールバック

**必要な作業**:
1. Redisサーバーのセットアップ
2. Vercelに環境変数を設定
3. リアルタイム機能の動作確認

**影響**:
- リアルタイム機能が動作しない
- セッション管理が最適化されない

#### 5. 外部API連携

**現状**:
- ❌ Claude API: 未連携（AI分析機能が動作しない）
- ❌ Google Search Console API: 未連携
- ❌ Google Ads API: 未連携
- ❌ Google Analytics 4: 未連携
- ❌ Meta Ads API: 未連携
- ❌ Shopify API: 未連携

**必要な作業**:
各APIの実装（`lib/integrations/`内のTODOコメント参照）

**影響**:
- AI分析機能が動作しない
- SEO分析機能が動作しない
- 広告連携機能が動作しない

#### 6. トラッキングスクリプトの最適化

**現状**:
- ✅ 基本的なトラッキング機能は実装済み
- ⚠️ スクリプトサイズが最適化されていない
- ⚠️ バッチ送信が未実装

**必要な作業**:
1. スクリプトの最適化（5KB以下目標）
2. バッチ送信の実装
3. エラー処理の改善

---

### 🟢 優先度: 中（1ヶ月以内）

#### 7. データベーススキーマの最適化

**現状**:
- ✅ 基本的なテーブル定義は実装済み
- ⚠️ パーティション設定の最適化が必要
- ⚠️ インデックスの最適化が必要

#### 8. パフォーマンス最適化

**現状**:
- ✅ 基本的な機能は実装済み
- ⚠️ クエリの最適化が必要
- ⚠️ キャッシュ戦略の実装が必要

#### 9. モニタリングとログ

**現状**:
- ✅ 基本的なログは実装済み
- ❌ 構造化ログの実装が必要
- ❌ アラート機能の実装が必要
- ❌ メトリクス収集の実装が必要

---

## 📋 実装済みコードの詳細

### ClickHouse接続 (`lib/clickhouse.ts`)

**主要関数**:
- `getClickHouseClient()`: クライアントの取得（同期）
- `getClickHouseClientAsync()`: クライアントの取得（非同期、接続テスト付き）
- `testClickHouseConnection()`: 接続テスト
- `isClickHouseConnected()`: 接続状態確認
- `resetClickHouseConnection()`: 接続リセット
- `initializeDatabase()`: データベース初期化

**エラーハンドリング**:
- 接続エラー（ECONNREFUSED、ETIMEDOUT）の自動検出
- 接続エラー時の自動リセット
- 詳細なエラーログ（エラーコード、メッセージ、スタックトレース）

### 認証API (`app/api/auth/`)

**登録API** (`register/route.ts`):
- メールアドレス形式バリデーション
- パスワード強度チェック（8文字以上）
- 既存ユーザーチェック（メモリ内 + ClickHouse）
- パスワードハッシュ化（bcrypt）
- ClickHouseへの保存（接続可能な場合）
- メモリ内ストレージへのフォールバック
- 警告メッセージの返却

**ログインAPI** (`login/route.ts`):
- ✅ ClickHouse接続可能な場合は、ClickHouseを優先して検索
- ✅ ClickHouse接続不可時はメモリ内ストレージから検索（フォールバック）
- ✅ パスワード検証（bcrypt）
- ✅ セッション情報の返却（パスワード除外）

**登録API** (`register/route.ts`):
- ✅ ClickHouse接続可能な場合は、ClickHouseを優先して重複チェック
- ✅ ClickHouse接続可能な場合は、ClickHouseを優先して保存
- ✅ 保存成功後、メモリ内ストレージにも保存（キャッシュとして）
- ✅ ClickHouse接続不可時はメモリ内ストレージのみに保存
- ✅ 警告メッセージの返却（メモリ内のみ保存の場合）

---

## 🔍 接続状態の確認方法

### 1. Healthエンドポイントで確認

```bash
# ローカル環境
curl http://localhost:3000/api/health

# 本番環境
curl https://heatclick-p47dqkc2q-hiroki101313-gmailcoms-projects.vercel.app/api/health
```

### 2. ログで確認

サーバーログで以下のメッセージを確認：
- `ClickHouse client initialized`: 接続成功
- `ClickHouse connection test failed`: 接続失敗
- `ClickHouse not connected`: 接続不可（メモリ内ストレージ使用）

### 3. ブラウザで確認

1. アプリケーションにアクセス
2. ユーザー登録を試行
3. 警告メッセージが表示されるか確認
4. ログインが正常に動作するか確認

---

## 🚀 次のステップ

### 即座に実施すべきこと

1. **ClickHouseサーバーのセットアップ**
   - Hetznerサーバーで`scripts/setup-server.sh`を実行
   - または、ClickHouse Cloudなどのマネージドサービスを使用

2. **Vercelに環境変数を設定**
   ```bash
   vercel env add CLICKHOUSE_HOST production
   vercel env add CLICKHOUSE_PORT production
   vercel env add CLICKHOUSE_USER production
   vercel env add CLICKHOUSE_PASSWORD production
   vercel env add CLICKHOUSE_DATABASE production
   ```

3. **変更をデプロイ**
   ```bash
   git add .
   git commit -m "Fix ClickHouse connection issues and improve authentication"
   git push origin main
   ```

4. **接続テスト**
   - `/api/health`エンドポイントで接続確認
   - ユーザー登録とログインの動作確認

### 1週間以内に実施すべきこと

1. **Redisサーバーのセットアップ**
2. **外部API連携の実装開始**
3. **トラッキングスクリプトの最適化**

---

## 📝 補足情報

### デプロイ情報

- **プラットフォーム**: Vercel
- **プロジェクト名**: heatclick-ai
- **本番URL**: https://heatclick-p47dqkc2q-hiroki101313-gmailcoms-projects.vercel.app
- **管理画面**: https://vercel.com/hiroki101313-gmailcoms-projects/heatclick-ai
- **最終デプロイ**: 2025年1月25日

### 関連ドキュメント

- `docs/clickhouse-connection-fixes.md` - ClickHouse接続修正の詳細
- `docs/development-log.md` - 開発ログ
- `docs/project-status.md` - プロジェクト状況
- `docs/issues.md` - 既知の問題

---

## ✅ チェックリスト

### 緊急（即座に対応）

- [ ] ClickHouseサーバーのセットアップ
- [ ] Vercelに環境変数を設定
- [ ] 変更をデプロイ
- [ ] 接続テストの実施
- [ ] ユーザー登録・ログインの動作確認

### 高優先度（1-2週間以内）

- [ ] Redisサーバーのセットアップ
- [ ] 外部API連携の実装
- [ ] トラッキングスクリプトの最適化

### 中優先度（1ヶ月以内）

- [ ] データベーススキーマの最適化
- [ ] パフォーマンス最適化
- [ ] モニタリングとログの実装

---

**最終更新**: 2025年1月26日

