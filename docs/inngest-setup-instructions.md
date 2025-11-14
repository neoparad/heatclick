# Inngest セットアップ手順

**作成日**: 2025年1月26日

---

## 📋 前提条件

- Inngestアカウント（GitHubアカウントで登録済み）
- Vercelプロジェクト
- ClickHouseサーバー（Hetzner）
- Redisサーバー（Hetzner）

---

## 🚀 セットアップ手順

### Step 1: Inngestパッケージのインストール

```bash
npm install inngest
```

### Step 2: 環境変数の設定

`.env.local`に以下を追加:

```env
INNGEST_EVENT_KEY=your_inngest_event_key
INNGEST_SIGNING_KEY=your_inngest_signing_key
```

**取得方法**:
1. Inngestダッシュボードにログイン
2. プロジェクト設定から Event Key と Signing Key を取得

### Step 3: ClickHouseテーブルの作成

ClickHouseサーバーに接続して、以下のSQLを実行:

```bash
# ClickHouseサーバーに接続
clickhouse-client --host=your-host --user=default --password=your-password

# SQLファイルを実行
# docs/clickhouse-heatmap-summary-table.sql の内容を実行
```

または、`docs/clickhouse-heatmap-summary-table.sql`の内容をコピーして実行。

### Step 4: Vercelへのデプロイ

```bash
git add .
git commit -m "feat: Inngest統合によるヒートマップパフォーマンス改善"
git push origin main
```

Vercelが自動的にデプロイします。

### Step 5: Inngestダッシュボードでの確認

1. Inngestダッシュボードにアクセス
2. プロジェクトを選択
3. Functionsタブで以下が表示されることを確認:
   - `daily-heatmap-aggregation` (Cron: 0 4 * * *)
   - `rebuild-all-heatmap-summary` (Event: heatmap.rebuild)
   - `heatmap-cache-warming` (Cron: 0 */6 * * *)

### Step 6: 初期データの集約（1回だけ実行）

```bash
# ローカル環境
curl -X POST http://localhost:3000/api/inngest/rebuild

# 本番環境
curl -X POST https://your-domain.com/api/inngest/rebuild
```

または、Inngestダッシュボードから手動でイベントを送信:
- Event名: `heatmap.rebuild`

---

## ✅ 動作確認

### 1. 日次集約ジョブの確認

- Inngestダッシュボードで`daily-heatmap-aggregation`の実行履歴を確認
- 毎朝5:00（JST）に自動実行される

### 2. キャッシュウォーミングの確認

- Inngestダッシュボードで`heatmap-cache-warming`の実行履歴を確認
- 6時間ごとに自動実行される

### 3. API応答時間の確認

```bash
# キャッシュありの場合
time curl "http://localhost:3000/api/heatmap?site_id=xxx&page_url=xxx"

# キャッシュなしの場合（初回アクセス）
time curl "http://localhost:3000/api/heatmap?site_id=xxx&page_url=xxx"
```

**期待値**:
- キャッシュあり: < 100ms
- キャッシュなし: < 3秒

---

## 🔧 トラブルシューティング

### Inngest関数が表示されない

1. `/app/api/inngest/route.ts`が正しく作成されているか確認
2. Vercelにデプロイされているか確認
3. Inngestダッシュボードで接続状態を確認

### ClickHouseクエリエラー

1. テーブルが作成されているか確認
2. 環境変数が正しく設定されているか確認
3. ClickHouseサーバーに接続できるか確認

### キャッシュが効かない

1. Redis接続を確認
2. キャッシュキーが正しく生成されているか確認
3. Redisのメモリ使用量を確認

---

## 📚 関連ドキュメント

- [ヒートマップInngest実装ガイド](./heatmap-inngest-implementation-guide.md)
- [ClickHouseテーブル作成SQL](./clickhouse-heatmap-summary-table.sql)

---

**最終更新**: 2025年1月26日


