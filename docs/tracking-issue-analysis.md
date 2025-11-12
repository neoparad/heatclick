# トラッキングデータ表示問題の調査レポート

**調査日**: 2025年1月25日  
**問題**: 各ページのトラッキングがサイトに反映されない

---

## 🔍 問題の分析

### 1. 問題の症状

- ダッシュボード、クリック分析、リアルタイムページでトラッキングデータが表示されない
- データは保存されているが、フロントエンドに表示されない可能性

### 2. 原因の特定

#### 問題1: `/api/track` GETメソッドがメモリ内データのみを返していた

**場所**: `app/api/track/route.ts` (149-175行目)

**問題点**:
- ClickHouseに保存されたデータを取得していない
- メモリ内の `trackingData` 配列のみを返していた
- サーバー再起動でデータが消失する

**影響**:
- リアルタイムページで最新のトラッキングデータが表示されない
- ClickHouseに保存されたデータが反映されない

#### 問題2: リアルタイムページでサイト選択がなかった

**場所**: `app/realtime/page.tsx`

**問題点**:
- サイトIDを指定せずにデータを取得していた
- すべてのサイトのデータを取得しようとしていた
- サイト選択UIがなかった

**影響**:
- 特定のサイトのデータを表示できない
- データが混在して表示される可能性

#### 問題3: データフローの不整合

**正常なデータフロー**:
1. トラッキングスクリプト → `/api/track` (POST) → ClickHouseに保存 ✅
2. ダッシュボード → `/api/statistics` → ClickHouseから取得 ✅
3. クリック分析 → `/api/clicks` → ClickHouseから取得 ✅
4. リアルタイムページ → `/api/track` (GET) → **メモリ内データのみ** ❌

---

## ✅ 実装した解決策

### 解決策1: `/api/track` GETメソッドを修正

**変更内容**:
- ClickHouseからデータを取得するように修正
- サイトIDとイベントタイプでフィルタリング可能に
- エラー時はメモリ内データにフォールバック

**実装コード**:
```typescript
// ClickHouseからデータを取得
const clickhouse = await getClickHouseClientAsync()
let query = `
  SELECT 
    id,
    site_id as siteId,
    session_id as sessionId,
    user_id as userId,
    event_type as eventType,
    timestamp,
    url as page_url,
    ...
  FROM clickinsight.events
  WHERE 1=1
`

if (siteId) {
  query += ` AND site_id = {site_id:String}`
  params.site_id = siteId
}

if (eventType) {
  query += ` AND event_type = {event_type:String}`
  params.event_type = eventType
}

query += ` ORDER BY timestamp DESC LIMIT {limit:UInt32}`
```

### 解決策2: リアルタイムページにサイト選択を追加

**変更内容**:
- サイト一覧を取得してドロップダウン表示
- 選択されたサイトのデータのみを表示
- サイト選択が必須になるように修正

**実装コード**:
```typescript
// サイト一覧の取得
useEffect(() => {
  const fetchSites = async () => {
    const response = await fetch('/api/sites')
    const data = await response.json()
    setSites(data.sites || [])
    if (data.sites && data.sites.length > 0) {
      setSelectedSite(data.sites[0].tracking_id)
    }
  }
  fetchSites()
}, [])

// 選択されたサイトのデータを取得
const fetchData = async () => {
  if (!selectedSite) return
  const response = await fetch(`/api/track?siteId=${selectedSite}&limit=50`)
  // ...
}
```

### 解決策3: データ形式の統一

**変更内容**:
- ClickHouseから取得したデータのフィールド名を統一
- `site_id` → `siteId`, `event_type` → `eventType` など
- フロントエンドで使用しやすい形式に変換

---

## 🔧 追加の確認事項

### 1. トラッキングスクリプトの設置確認

**確認ポイント**:
- `window.CLICKINSIGHT_SITE_ID` が正しく設定されているか
- トラッキングスクリプトが正しく読み込まれているか
- ブラウザのコンソールにエラーがないか

**確認方法**:
```javascript
// ブラウザのコンソールで確認
console.log(window.CLICKINSIGHT_SITE_ID)
console.log(window.CLICKINSIGHT_API_URL)
```

### 2. ClickHouse接続の確認

**確認ポイント**:
- ClickHouseが正しく接続されているか
- `clickinsight.events` テーブルが存在するか
- データが正しく保存されているか

**確認方法**:
```sql
-- ClickHouseで確認
SELECT count() FROM clickinsight.events;
SELECT * FROM clickinsight.events ORDER BY timestamp DESC LIMIT 10;
```

### 3. APIエンドポイントの動作確認

**確認ポイント**:
- `/api/track` (POST) が正しくデータを受信しているか
- `/api/track` (GET) が正しくデータを返しているか
- `/api/statistics` が正しくデータを返しているか

**確認方法**:
```bash
# APIテスト
curl -X POST http://localhost:3000/api/track \
  -H "Content-Type: application/json" \
  -d '{"events": [{"site_id": "YOUR_SITE_ID", "event_type": "click", ...}]}'

curl "http://localhost:3000/api/track?siteId=YOUR_SITE_ID&limit=10"
```

---

## 📊 データフローの確認

### 正常なデータフロー（修正後）

1. **トラッキングスクリプト** → `/api/track` (POST)
   - イベントデータを送信
   - ClickHouseに保存 ✅

2. **ダッシュボード** → `/api/statistics?site_id=XXX`
   - ClickHouseから統計データを取得 ✅

3. **クリック分析** → `/api/clicks?site_id=XXX`
   - ClickHouseからクリックデータを取得 ✅

4. **リアルタイムページ** → `/api/track?siteId=XXX&limit=50`
   - ClickHouseから最新イベントを取得 ✅（修正済み）

---

## 🐛 考えられるその他の問題

### 問題1: サイトIDの不一致

**症状**: データは保存されているが、別のサイトIDで検索している

**解決策**:
- トラッキングスクリプトの `CLICKINSIGHT_SITE_ID` と
- ダッシュボードで選択している `tracking_id` が一致しているか確認

### 問題2: タイムゾーンの問題

**症状**: データが表示されない、または古いデータが表示される

**解決策**:
- ClickHouseのタイムスタンプとフロントエンドのタイムゾーンを確認
- 日付フィルターが正しく機能しているか確認

### 問題3: CORSの問題

**症状**: トラッキングスクリプトからAPIへのリクエストが失敗する

**解決策**:
- `/api/track` のCORS設定を確認
- ブラウザのコンソールでエラーを確認

---

## ✅ 修正完了項目

1. ✅ `/api/track` GETメソッドをClickHouseからデータを取得するように修正
2. ✅ リアルタイムページにサイト選択機能を追加
3. ✅ データ形式の統一（フィールド名の変換）
4. ✅ エラーハンドリングとフォールバック機能の実装

---

## 📝 次のステップ

### 推奨される確認手順

1. **トラッキングスクリプトの動作確認**
   - テストサイトにトラッキングスクリプトを設置
   - ブラウザのコンソールでエラーを確認
   - ネットワークタブで `/api/track` へのリクエストを確認

2. **データ保存の確認**
   - ClickHouseに接続してデータが保存されているか確認
   - サイトIDが正しく保存されているか確認

3. **フロントエンドの表示確認**
   - ダッシュボードでデータが表示されるか確認
   - リアルタイムページでデータが表示されるか確認
   - サイト選択が正しく機能しているか確認

4. **エラーログの確認**
   - サーバーログでエラーがないか確認
   - ブラウザのコンソールでエラーがないか確認

---

## 🔍 デバッグ用のチェックリスト

- [ ] トラッキングスクリプトが正しく読み込まれている
- [ ] `window.CLICKINSIGHT_SITE_ID` が設定されている
- [ ] `/api/track` (POST) が200レスポンスを返している
- [ ] ClickHouseにデータが保存されている
- [ ] `/api/track` (GET) がデータを返している
- [ ] サイトIDが一致している
- [ ] タイムゾーンが正しい
- [ ] CORS設定が正しい

---

**修正日**: 2025年1月25日  
**修正者**: AI Assistant  
**ステータス**: ✅ 修正完了

