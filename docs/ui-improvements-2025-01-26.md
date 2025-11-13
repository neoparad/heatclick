# UI改善内容 - 2025年1月26日

**更新日**: 2025年1月26日  
**目的**: ロゴ表示の改善と流入元情報の実装状況確認

---

## ✅ 実施した改善

### 1. ロゴ表示の改善

#### 問題点
- サイドバーの左上にロゴ画像とテキスト「UGOKI MAP」が混在して表示されていた
- ロゴ画像だけで十分なのに、テキストが重複していた

#### 実装内容

**変更ファイル**: `components/layout/Sidebar.tsx`

**変更前**:
```tsx
<button className="flex items-center gap-2 ...">
  <img src="/ugokimap.png" alt="UGOKI MAP" className="h-8 w-auto" />
  <span className="font-bold text-lg">UGOKI MAP</span>
</button>
```

**変更後**:
```tsx
<button className="flex items-center ...">
  <img src="/ugokimap.png" alt="UGOKI MAP" className="h-8 w-auto" />
</button>
```

**効果**:
- ✅ ロゴ画像のみが表示され、よりシンプルなデザインに
- ✅ テキストの重複が解消され、視認性が向上

---

### 2. ロゴファイルの配置

#### 実装内容
- `C:\Users\linkth\ugokimap.png`を`public/ugokimap.png`にコピー
- 以下のページでロゴを表示：
  - サイドバー（`components/layout/Sidebar.tsx`）
  - トップページ（`app/page.tsx`）
  - ログインページ（`app/auth/login/page.tsx`）
  - 登録ページ（`app/auth/register/page.tsx`）
  - インストールページ（`app/install/page.tsx`）

**フォールバック**:
- ロゴ画像が読み込めない場合、既存のグラデーションアイコンを表示

---

## 📊 流入元情報の実装状況確認

### 実装済み機能

#### 1. トラッキングスクリプト（`public/tracking.js`）

**実装内容**:
- ✅ `document.referrer`を取得してイベントに含める
- ✅ UTMパラメータ（`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`）を取得
- ✅ `getUtmParams()`関数でURLパラメータからUTM情報を抽出

**コード例**:
```javascript
const getUtmParams = () => {
  const params = new URLSearchParams(window.location.search);
  return {
    utm_source: params.get('utm_source') || '',
    utm_medium: params.get('utm_medium') || '',
    utm_campaign: params.get('utm_campaign') || '',
    utm_term: params.get('utm_term') || '',
    utm_content: params.get('utm_content') || '',
    gclid: params.get('gclid') || '',
    fbclid: params.get('fbclid') || '',
  };
};

const queueEvent = (event) => {
  eventQueue.push({
    ...event,
    referrer: document.referrer,
    ...utmParams,
  });
};
```

---

#### 2. APIエンドポイント（`app/api/track/route.ts`）

**実装内容**:
- ✅ イベントデータから`referrer`を取得してClickHouseに保存
- ✅ UTMパラメータ（`utm_source`, `utm_medium`など）を取得してClickHouseに保存

**コード例**:
```typescript
const clickHouseEvents = events.map(event => ({
  // ...
  referrer: event.referrer || null,
  utm_source: event.utm_source || null,
  utm_medium: event.utm_medium || null,
  utm_campaign: event.utm_campaign || null,
  // ...
}))
```

---

#### 3. データ取得関数（`lib/clickhouse.ts`）

**実装内容**:
- ✅ `getTrafficSources()`関数が実装済み
- ✅ リファラー別の統計を取得（セッション数、ページビュー数）
- ✅ UTMソース別の統計を取得（セッション数、ページビュー数）

**クエリ例**:
```sql
-- リファラー別の統計
SELECT 
  CASE 
    WHEN referrer = '' OR referrer IS NULL THEN 'direct'
    ELSE referrer
  END as referrer,
  count() as sessions,
  uniq(session_id) as unique_sessions,
  countIf(event_type = 'page_view' OR event_type = 'pageview') as page_views
FROM clickinsight.events
WHERE site_id = {site_id:String}
  AND (event_type = 'page_view' OR event_type = 'pageview')
GROUP BY referrer
ORDER BY sessions DESC
LIMIT 20
```

---

#### 4. APIエンドポイント（`app/api/traffic-sources/route.ts`）

**実装内容**:
- ✅ 流入元情報を取得するAPIエンドポイントが実装済み
- ✅ リファラー別とUTMソース別の統計を返す

**API仕様**:
```
GET /api/traffic-sources?site_id=xxx&start_date=xxx&end_date=xxx
```

**レスポンス**:
```json
{
  "success": true,
  "data": {
    "referrers": [
      {
        "referrer": "direct",
        "sessions": 100,
        "unique_sessions": 95,
        "page_views": 150
      }
    ],
    "utm_sources": [
      {
        "utm_source": "google",
        "utm_medium": "cpc",
        "sessions": 50,
        "unique_sessions": 45,
        "page_views": 75
      }
    ]
  }
}
```

---

#### 5. フロントエンドUI（`app/dashboard/page.tsx`）

**実装内容**:
- ✅ 流入元（リファラー）の表示UIが実装済み
- ✅ 流入チャネル（UTMソース）の表示UIが実装済み
- ✅ セッション数、ページビュー数、割合を表示
- ✅ 期間フィルターに対応

**表示内容**:
- リファラー別: リファラー名、セッション数、ページビュー数、割合
- UTMソース別: UTMソース、UTMメディア、セッション数、ページビュー数、割合

---

## 📊 データフロー

```
1. ユーザーアクセス
   ↓
2. トラッキングスクリプト (tracking.js)
   - document.referrer を取得
   - URLパラメータからUTM情報を取得
   ↓
3. /api/track エンドポイント
   - referrer, utm_source, utm_medium などを保存
   ↓
4. ClickHouse (eventsテーブル)
   - referrer, utm_source, utm_medium などのフィールドに保存
   ↓
5. /api/traffic-sources エンドポイント
   - getTrafficSources() 関数で集計
   ↓
6. ダッシュボードUI
   - リファラー別統計を表示
   - UTMソース別統計を表示
```

---

## ✅ 動作確認項目

### ロゴ表示
- ✅ サイドバーの左上にロゴ画像のみが表示される（テキストなし）
- ✅ ロゴ画像が読み込めない場合、フォールバックアイコンが表示される

### 流入元情報
- ✅ トラッキングタグが設置されているサイトで、リファラー情報が取得される
- ✅ UTMパラメータ付きのURLでアクセスした場合、UTM情報が取得される
- ✅ ダッシュボードに流入元（リファラー）と流入チャネル（UTMソース）が表示される
- ✅ 期間フィルターに応じてデータが更新される

---

## 🔍 注意事項

### データが表示されない場合の原因

1. **トラッキングタグが正しく設置されていない**
   - サイト管理ページからトラッキングコードをコピーして設置してください

2. **まだデータが蓄積されていない**
   - 新規サイトの場合、データが蓄積されるまで時間がかかります
   - テストアクセスを行ってデータを生成してください

3. **すべてのアクセスが直接アクセス**
   - referrerがない場合（ブックマークから、直接URL入力など）は「直接アクセス」として表示されます
   - UTMパラメータがない場合も「直接アクセス」として表示されます

### UTMパラメータの取得

- URLに`?utm_source=xxx&utm_medium=xxx`などのパラメータが含まれている場合のみ取得されます
- 例: `https://example.com/page?utm_source=google&utm_medium=cpc`
- セッション開始時のUTMパラメータが記録されます（セッション中に変更されても最初の値が保持されます）

---

## 📝 関連ファイル

- `components/layout/Sidebar.tsx`: ロゴ表示の修正
- `app/page.tsx`: トップページのロゴ表示
- `app/auth/login/page.tsx`: ログインページのロゴ表示
- `app/auth/register/page.tsx`: 登録ページのロゴ表示
- `app/install/page.tsx`: インストールページのロゴ表示
- `public/tracking.js`: トラッキングスクリプト（referrer、UTMパラメータ取得）
- `app/api/track/route.ts`: イベント受信API（referrer、UTMパラメータ保存）
- `lib/clickhouse.ts`: 流入元情報取得関数
- `app/api/traffic-sources/route.ts`: 流入元情報APIエンドポイント
- `app/dashboard/page.tsx`: ダッシュボードUI（流入元情報表示）

---

## 📚 関連ドキュメント

- [最新の変更内容まとめ](./latest-changes-2025-01-26.md) - 本日の実装内容の詳細

---

**最終更新**: 2025年1月26日

