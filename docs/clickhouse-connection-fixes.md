# ClickHouse接続問題の修正内容

## 修正日: 2025-01-XX

## 問題の概要

1. **認証問題**: ID/パスワードを登録してもアクセスできなくなる
2. **ClickHouse接続問題**: 接続がうまくいかない

## 実施した修正

### 1. ClickHouse接続の改善 (`lib/clickhouse.ts`)

#### 接続設定の改善
- `CLICKHOUSE_URL`環境変数のサポートを追加
- `CLICKHOUSE_USER`と`CLICKHOUSE_USERNAME`の両方をサポート
- 接続タイムアウトと最大接続数の設定を追加

#### 接続テスト機能の追加
- `testClickHouseConnection()`: 詳細な接続テストとエラー情報を返す
- `isClickHouseConnected()`: 接続状態を確認（エラーをスローしない）
- 定期的な接続テスト（1分ごと）

#### 接続リセット機能
- `resetClickHouseConnection()`: 接続をリセットして再接続を試みる
- 接続エラー検出時の自動リセット

#### エラーハンドリングの改善
- 詳細なエラーログ（エラーコード、メッセージ、スタックトレース）
- 接続エラー（ECONNREFUSED、ETIMEDOUT）の検出と自動リセット
- すべてのクエリ関数で`getClickHouseClientAsync()`を使用

### 2. 認証APIの改善

#### 登録API (`app/api/auth/register/route.ts`)
- ClickHouse接続失敗時の警告メッセージを追加
- メモリ内ストレージのみに保存された場合の警告を返す
- エラーログの改善

#### ログインAPI (`app/api/auth/login/route.ts`)
- ClickHouse接続失敗時の警告ログを改善
- メモリ内ストレージからの検索を継続

### 3. その他のAPIルートの改善

#### `app/api/clicks/route.ts`
- `getClickHouseClientAsync()`を使用
- 接続エラー時の詳細ログ
- 空データ返却時の警告メッセージ

#### `app/api/usage/route.ts`
- `getClickHouseClientAsync()`を使用
- エラーログの改善

### 4. Healthエンドポイントの改善 (`app/api/health/route.ts`)

- 詳細な接続状態情報を返す
- 環境変数の確認（パスワードは非表示）
- エラー詳細と推奨事項を提供
- 接続エラー情報の表示

## 使用方法

### 接続テスト

```bash
# Healthエンドポイントで接続状態を確認
curl http://localhost:3000/api/health

# レスポンス例
{
  "status": "ok",
  "clickhouse": {
    "connected": true,
    "config": {
      "url": "http://localhost:8123",
      "database": "clickinsight",
      "username": "default"
    }
  }
}
```

### 環境変数の設定

`.env.local`に以下を設定：

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

## トラブルシューティング

### 接続できない場合

1. **Healthエンドポイントで確認**
   ```bash
   curl http://localhost:3000/api/health
   ```

2. **環境変数を確認**
   - Healthエンドポイントのレスポンスに環境変数の状態が表示されます

3. **ClickHouseサーバーの確認**
   ```bash
   # ClickHouseサーバーが起動しているか確認
   curl http://localhost:8123
   ```

4. **ネットワーク接続の確認**
   - ファイアウォール設定
   - ポートの開放状況
   - ホスト名/IPアドレスの確認

### 認証が失敗する場合

1. **ClickHouse接続を確認**
   - Healthエンドポイントで接続状態を確認
   - 接続できない場合、メモリ内ストレージのみに保存される
   - サーバー再起動でデータが失われる

2. **ログを確認**
   - サーバーログでClickHouse接続エラーを確認
   - 警告メッセージが表示される

## 今後の改善点

1. **永続化ストレージの追加**
   - ClickHouse接続失敗時でもデータを保持する仕組み
   - ファイルベースのフォールバック

2. **接続プールの最適化**
   - 接続数の調整
   - 接続の再利用

3. **リトライロジックの追加**
   - 自動リトライ
   - 指数バックオフ

4. **モニタリングの追加**
   - 接続状態の監視
   - アラート機能

