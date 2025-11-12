# トラッキングデータ表示問題のデバッグガイド

**サイト**: https://bihadashop.jp  
**サイトID**: `CIP_EcwUTHEZdIOAUqum`  
**問題**: 管理画面で数字が表示されない

---

## 🔍 問題の診断手順

### ステップ1: トラッキングスクリプトの動作確認

#### 1.1 ブラウザのコンソールで確認

1. https://bihadashop.jp にアクセス
2. ブラウザの開発者ツールを開く（F12）
3. コンソールタブで以下を確認：

```javascript
// サイトIDが正しく設定されているか確認
console.log(window.CLICKINSIGHT_SITE_ID)
// 期待値: "CIP_EcwUTHEZdIOAUqum"

// APIエンドポイントが正しく設定されているか確認
console.log(window.CLICKINSIGHT_API_URL)
// 期待値: "https://heatclick-ai.vercel.app/api/track"
```

#### 1.2 ネットワークタブで確認

1. ネットワークタブを開く
2. フィルターで "track" を検索
3. `/api/track` へのリクエストを確認：
   - リクエストが送信されているか
   - ステータスコード（200が正常）
   - リクエストボディに `site_id: "CIP_EcwUTHEZdIOAUqum"` が含まれているか
   - レスポンスが `{"success": true, "received": X}` を返しているか

#### 1.3 エラーの確認

コンソールに以下のエラーがないか確認：
- `ClickInsight Pro: CLICKINSIGHT_SITE_ID is required` → サイトIDが設定されていない
- CORSエラー → APIエンドポイントの設定が間違っている
- 404エラー → スクリプトファイルが見つからない

---

### ステップ2: データベースの確認

#### 2.1 サイトIDがデータベースに存在するか確認

**ClickHouseで確認**:
```sql
SELECT * FROM clickinsight.sites 
WHERE tracking_id = 'CIP_EcwUTHEZdIOAUqum';
```

**期待される結果**:
- 1行のデータが返される
- `status` が `'active'` である

**問題がある場合**:
- データが存在しない → サイトを再登録する必要がある
- `status` が `'inactive'` → サイトをアクティブにする必要がある

#### 2.2 イベントデータが保存されているか確認

**ClickHouseで確認**:
```sql
SELECT count() as total_events
FROM clickinsight.events
WHERE site_id = 'CIP_EcwUTHEZdIOAUqum';

SELECT * FROM clickinsight.events
WHERE site_id = 'CIP_EcwUTHEZdIOAUqum'
ORDER BY timestamp DESC
LIMIT 10;
```

**期待される結果**:
- `total_events` が 0 より大きい
- 最新10件のイベントデータが表示される

**問題がある場合**:
- `total_events` が 0 → データが保存されていない
  - APIエンドポイントが正しく動作していない可能性
  - ClickHouseへの接続に問題がある可能性

---

### ステップ3: APIエンドポイントの確認

#### 3.1 手動でAPIをテスト

**curlコマンドでテスト**:
```bash
curl -X POST https://heatclick-ai.vercel.app/api/track \
  -H "Content-Type: application/json" \
  -H "Origin: https://bihadashop.jp" \
  -d '{
    "events": [{
      "site_id": "CIP_EcwUTHEZdIOAUqum",
      "event_type": "page_view",
      "session_id": "test-session-123",
      "user_id": "test-user-123",
      "url": "https://bihadashop.jp/",
      "timestamp": "2025-01-25T12:00:00Z"
    }]
  }'
```

**期待されるレスポンス**:
```json
{
  "success": true,
  "received": 1
}
```

**エラーレスポンスの場合**:
- `{"error": "Invalid event data"}` → リクエストデータの形式が間違っている
- `{"error": "Too many requests"}` → レート制限に引っかかっている
- `500 Internal Server Error` → サーバー側のエラー

#### 3.2 APIからデータを取得して確認

```bash
curl "https://heatclick-ai.vercel.app/api/track?siteId=CIP_EcwUTHEZdIOAUqum&limit=10"
```

**期待されるレスポンス**:
```json
{
  "data": [...],
  "total": 10,
  "filtered": 10,
  "source": "clickhouse"
}
```

---

### ステップ4: 管理画面での確認

#### 4.1 サイト選択の確認

1. 管理画面のダッシュボードにアクセス
2. サイト選択ドロップダウンで `CIP_EcwUTHEZdIOAUqum` が表示されているか確認
3. 正しいサイトが選択されているか確認

#### 4.2 APIリクエストの確認

1. ブラウザの開発者ツールを開く
2. ネットワークタブで以下を確認：
   - `/api/statistics?site_id=CIP_EcwUTHEZdIOAUqum`
   - `/api/clicks?site_id=CIP_EcwUTHEZdIOAUqum`
   - `/api/track?siteId=CIP_EcwUTHEZdIOAUqum`

3. 各リクエストのレスポンスを確認：
   - ステータスコードが200か
   - データが返されているか

---

## 🐛 よくある問題と解決策

### 問題1: サイトIDがデータベースに存在しない

**症状**: 
- 管理画面でサイトが表示されない
- データが表示されない

**解決策**:
1. 管理画面の「サイト管理」ページでサイトを確認
2. サイトID `CIP_EcwUTHEZdIOAUqum` が存在するか確認
3. 存在しない場合は、サイトを再登録する

### 問題2: トラッキングスクリプトが読み込まれていない

**症状**:
- ブラウザのコンソールにエラーが表示される
- ネットワークタブで `/api/track` へのリクエストがない

**解決策**:
1. HTMLの `<head>` タグ内にトラッキングスクリプトが正しく設置されているか確認
2. スクリプトのパスが正しいか確認（`https://heatclick-ai.vercel.app/tracking.js`）
3. ブラウザのコンソールでスクリプトの読み込みエラーを確認

### 問題3: CORSエラー

**症状**:
- ブラウザのコンソールにCORSエラーが表示される
- ネットワークタブで `/api/track` へのリクエストが失敗する

**解決策**:
1. APIエンドポイントのCORS設定を確認
2. `Origin` ヘッダーが正しく設定されているか確認
3. サーバー側のCORS設定を確認

### 問題4: ClickHouseへの接続エラー

**症状**:
- APIは200を返すが、データが保存されていない
- サーバーログにClickHouse接続エラーが表示される

**解決策**:
1. ClickHouseの接続設定を確認
2. 環境変数 `CLICKHOUSE_URL` が正しく設定されているか確認
3. ClickHouseサーバーが起動しているか確認

### 問題5: サイトIDの不一致

**症状**:
- データは保存されているが、管理画面で表示されない
- 別のサイトIDでデータを検索している

**解決策**:
1. トラッキングスクリプトの `CLICKINSIGHT_SITE_ID` を確認
2. 管理画面で選択しているサイトIDを確認
3. 両者が一致しているか確認

---

## 🔧 デバッグ用のチェックリスト

- [ ] トラッキングスクリプトが正しく読み込まれている
- [ ] `window.CLICKINSIGHT_SITE_ID` が `"CIP_EcwUTHEZdIOAUqum"` に設定されている
- [ ] `window.CLICKINSIGHT_API_URL` が `"https://heatclick-ai.vercel.app/api/track"` に設定されている
- [ ] ブラウザのコンソールにエラーがない
- [ ] ネットワークタブで `/api/track` へのリクエストが送信されている
- [ ] `/api/track` へのリクエストが200を返している
- [ ] リクエストボディに `site_id: "CIP_EcwUTHEZdIOAUqum"` が含まれている
- [ ] サイトIDがデータベースに存在する
- [ ] サイトのステータスが `'active'` である
- [ ] ClickHouseにイベントデータが保存されている
- [ ] 管理画面で正しいサイトIDが選択されている
- [ ] `/api/statistics` がデータを返している
- [ ] `/api/clicks` がデータを返している

---

## 📊 データフローの確認

### 正常なデータフロー

1. **ユーザーがサイトにアクセス**
   ↓
2. **トラッキングスクリプトが実行される**
   - `window.CLICKINSIGHT_SITE_ID` を読み取る
   - イベントをキューに追加
   ↓
3. **バッチで `/api/track` (POST) に送信**
   - `site_id: "CIP_EcwUTHEZdIOAUqum"` を含む
   ↓
4. **APIがClickHouseに保存**
   - `clickinsight.events` テーブルに保存
   ↓
5. **管理画面が `/api/statistics` を呼び出し**
   - `site_id=CIP_EcwUTHEZdIOAUqum` で検索
   ↓
6. **データが表示される**

### 問題がある場合の確認ポイント

- ステップ2でエラー → トラッキングスクリプトの問題
- ステップ3でエラー → APIエンドポイントの問題
- ステップ4でエラー → ClickHouse接続の問題
- ステップ5でエラー → データ取得の問題

---

## 🚀 次のステップ

1. 上記のチェックリストを順番に確認
2. 問題が見つかった場合は、該当する解決策を実施
3. それでも解決しない場合は、サーバーログを確認
4. 必要に応じて、トラッキングスクリプトのデバッグモードを有効にする

**デバッグモードの有効化**:
```html
<script>
    window.CLICKINSIGHT_SITE_ID = 'CIP_EcwUTHEZdIOAUqum';
    window.CLICKINSIGHT_DEBUG = true; // デバッグモードを有効化
    window.CLICKINSIGHT_API_URL = 'https://heatclick-ai.vercel.app/api/track';
</script>
```

デバッグモードを有効にすると、ブラウザのコンソールに詳細なログが表示されます。

---

**作成日**: 2025年1月25日  
**対象サイト**: https://bihadashop.jp  
**サイトID**: CIP_EcwUTHEZdIOAUqum

