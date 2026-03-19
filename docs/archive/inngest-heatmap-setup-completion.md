# Inngestヒートマップ集約テーブルセットアップ完了レポート

**作成日**: 2025年11月14日  
**目的**: Inngest実装後のヒートマップ表示問題を解決し、集約テーブルをセットアップ

---

## ✅ 完了した作業

### 1. ClickHouse集約テーブルの作成 ✅

**実行日時**: 2025年11月14日  
**実行コマンド**: 
```bash
node scripts/setup-heatmap-tables.js
```

**実行結果**:
- ✅ ClickHouseへの接続成功
- ✅ `heatmap_daily_summary`テーブル作成成功
- ✅ `heatmap_daily_summary_mv`マテビュー作成成功
- ✅ 既存データ確認: 116行のデータが既に存在

**テーブル構造**:
```sql
CREATE TABLE IF NOT EXISTS clickinsight.heatmap_daily_summary (
  site_id String,
  page_url String,
  device_type String,
  event_type String,
  date Date,
  click_x UInt16,
  click_y UInt16,
  click_count UInt32,
  unique_sessions UInt32,
  last_updated DateTime DEFAULT now()
)
ENGINE = SummingMergeTree(click_count, unique_sessions)
ORDER BY (site_id, page_url, event_type, date, device_type, click_x, click_y)
PARTITION BY toYYYYMM(date);
```

**マテビュー**:
- リアルタイムで`clickinsight.events`テーブルから集約データを自動生成
- 新しいクリックイベントが追加されると、自動的に集約テーブルに反映

---

### 2. ヒートマップAPIのフォールバックロジック実装 ✅

**問題**: Inngest実装後、集約テーブルが存在しない、またはデータが集約されていない場合にヒートマップが表示されなくなった

**解決策**: 
- 集約テーブルからの取得を試みる
- データがない、またはエラーが発生した場合、既存の`getHeatmapDataLegacy`に自動フォールバック
- エラーハンドリングを改善し、詳細なログを記録

**修正ファイル**: `app/api/heatmap/route.ts`

**動作フロー**:
1. キャッシュ（Redis）からデータ取得を試みる
2. キャッシュがない場合、集約テーブル（`heatmap_daily_summary`）から取得を試みる
3. 集約テーブルにデータがない、またはエラーが発生した場合、既存ロジック（`events`テーブルから直接取得）にフォールバック
4. 取得したデータをキャッシュに保存

---

### 3. 初期データの集約（手動実行が必要）

**実行方法**:

#### ローカル環境
```bash
curl -X POST http://localhost:3000/api/inngest/rebuild
```

#### 本番環境
```bash
curl -X POST https://heatclick-p47dqkc2q-hiroki101313-gmailcoms-projects.vercel.app/api/inngest/rebuild
```

**実行内容**:
- `heatmap.rebuild`イベントをInngestに送信
- `rebuildAll`関数が実行され、過去の全データを集約テーブルに集約
- 処理時間はデータ量によって異なる（数分〜数十分）

**注意事項**:
- 本番環境で実行する場合は、Inngestの環境変数（`INNGEST_EVENT_KEY`、`INNGEST_SIGNING_KEY`）が設定されている必要があります
- 大量のデータがある場合、処理に時間がかかる可能性があります
- Inngestダッシュボードで実行状況を確認できます

---

### 4. Inngestの日次集約ジョブの確認

**確認方法**:

1. **Inngestダッシュボードにアクセス**
   - https://app.inngest.com にログイン
   - プロジェクトを選択

2. **Functionsタブで確認**
   - `daily-heatmap-aggregation` - 日次集約ジョブ（毎朝5:00 JSTに実行）
   - `rebuild-all-heatmap-summary` - 過去データの再構築（手動実行）
   - `heatmap-cache-warming` - キャッシュウォーミング（6時間ごと）

3. **実行履歴の確認**
   - 各関数の実行履歴を確認
   - エラーが発生している場合は、エラーログを確認

**期待される動作**:
- `daily-heatmap-aggregation`: 毎朝5:00（JST）に昨日のデータを自動集約
- `heatmap-cache-warming`: 6時間ごとに人気ページのキャッシュを事前生成

---

## 📊 現在の状態

### テーブル状態
- ✅ `heatmap_daily_summary`テーブル: 作成済み（116行のデータが既に存在）
- ✅ `heatmap_daily_summary_mv`マテビュー: 作成済み（リアルタイム集約中）

### API動作
- ✅ フォールバックロジック実装済み
- ✅ 集約テーブルが未準備でも既存ロジックでヒートマップ表示可能
- ✅ 集約テーブルにデータがあれば、自動的に集約テーブルから取得

### 次のステップ（推奨）

#### ステップ1: 初期データの集約を実行

**本番環境で実行**:
```bash
curl -X POST https://heatclick-p47dqkc2q-hiroki101313-gmailcoms-projects.vercel.app/api/inngest/rebuild
```

**期待されるレスポンス**:
```json
{
  "success": true,
  "message": "Heatmap rebuild job triggered"
}
```

**実行後の確認**:
- Inngestダッシュボードで`rebuild-all-heatmap-summary`の実行状況を確認
- エラーがないことを確認
- 処理が完了するまで数分〜数十分待機（データ量による）

#### ステップ2: 集約データの確認

**ClickHouseで確認**:
```sql
-- 集約テーブルのデータ数を確認
SELECT count() FROM clickinsight.heatmap_daily_summary;

-- 最新の集約データを確認
SELECT 
  site_id,
  page_url,
  sum(click_count) as total_clicks,
  count() as unique_positions
FROM clickinsight.heatmap_daily_summary
GROUP BY site_id, page_url
ORDER BY total_clicks DESC
LIMIT 10;
```

#### ステップ3: ヒートマップ表示の確認

1. 本番環境でヒートマップページにアクセス
   - URL: `https://heatclick-p47dqkc2q-hiroki101313-gmailcoms-projects.vercel.app/heatmap`
2. サイトとページを選択
3. ヒートマップが正しく表示されることを確認
4. ブラウザの開発者ツールでAPIリクエストを確認
   - `/api/heatmap`のレスポンスを確認
   - `cached: false`の場合は集約テーブルから取得
   - `cached: true`の場合はキャッシュから取得

#### ステップ4: 日次集約ジョブの確認

1. **Inngestダッシュボードにアクセス**
   - https://app.inngest.com にログイン
   - プロジェクトを選択

2. **Functionsタブで確認**
   - `daily-heatmap-aggregation`が登録されていることを確認
   - Cron設定: `0 4 * * *` (UTC 4:00 = JST 13:00)

3. **実行履歴の確認**
   - 翌日の5:00（JST）に自動実行されることを確認
   - エラーがないことを確認

4. **キャッシュウォーミングの確認**
   - `heatmap-cache-warming`が6時間ごとに実行されることを確認

---

## 🔧 トラブルシューティング

### ヒートマップが表示されない場合

1. **ブラウザのコンソールを確認**
   - エラーメッセージを確認
   - APIリクエストのステータスコードを確認

2. **サーバーログを確認**
   - Vercelのログを確認
   - フォールバックロジックが動作しているか確認

3. **データベース接続を確認**
   - `/api/health`エンドポイントで接続状態を確認
   - ClickHouseへの接続が正常か確認

### 集約テーブルにデータが集約されない場合

1. **Inngestの環境変数を確認**
   - `INNGEST_EVENT_KEY`が設定されているか
   - `INNGEST_SIGNING_KEY`が設定されているか

2. **Inngestダッシュボードで確認**
   - 関数が正しく登録されているか
   - 実行履歴にエラーがないか

3. **手動で集約を実行**
   - `/api/inngest/rebuild`エンドポイントを実行
   - エラーメッセージを確認

---

## 📝 関連ドキュメント

- [Inngestセットアップ手順](./inngest-setup-instructions.md)
- [Inngest実装サマリー](./inngest-implementation-summary.md)
- [ヒートマップInngest実装ガイド](./heatmap-inngest-implementation-guide.md)
- [ClickHouseテーブル作成SQL](./clickhouse-heatmap-summary-table.sql)

---

**最終更新**: 2025年11月14日

