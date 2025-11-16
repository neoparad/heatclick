# 複数サイトトラッキング問題の原因と修正内容

## 問題の根本原因

### 1. **グローバル変数の競合**
**元のコードの問題：**
```javascript
// 元のコード
const config = {
  siteId: window.CLICKINSIGHT_SITE_ID || '',  // ← グローバル変数に依存
  // ...
};
```

**問題点：**
- 複数のサイトのトラッキングスクリプトが同じページに読み込まれた場合、最後に読み込まれたスクリプトが`window.CLICKINSIGHT_SITE_ID`を上書きしてしまう
- 各サイトが異なるページにある場合でも、ブラウザのキャッシュやスクリプトの読み込み順序によって、間違ったサイトIDが使用される可能性がある

### 2. **`async`属性による`document.currentScript`の無効化**
**問題点：**
- スクリプトタグに`async`属性がある場合、`document.currentScript`は`null`を返す
- これにより、スクリプトタグ自体を特定できず、`data-site-id`属性を読み取れない

### 3. **スクリプトタグの特定方法の不備**
**元のコード：**
```javascript
// 元のコード（不完全）
const currentScript = document.currentScript || (function() {
  const scripts = document.getElementsByTagName('script');
  return scripts[scripts.length - 1];  // ← 最後のスクリプトを取得（不正確）
})();
```

**問題点：**
- `async`属性がある場合、`document.currentScript`は`null`
- フォールバックとして最後のスクリプトを取得するが、複数のトラッキングスクリプトがある場合、正しいスクリプトを特定できない

## 修正内容

### 1. **`data-site-id`属性の優先使用**
各スクリプトタグに`data-site-id`属性を追加し、グローバル変数に依存しない方法を実装：

```javascript
// 修正後のコード
const getSiteId = () => {
  // Method 1: data-site-id属性から取得（最も確実）
  const allTrackingScripts = Array.from(document.querySelectorAll('script[src*="tracking.js"]'));
  for (let i = allTrackingScripts.length - 1; i >= 0; i--) {
    const script = allTrackingScripts[i];
    const siteId = script.getAttribute('data-site-id');
    if (siteId && !script.dataset.ciProcessed) {
      script.dataset.ciProcessed = 'true';
      return siteId;
    }
  }
  // ... フォールバック方法
};
```

### 2. **スクリプトタグ生成の改善**
生成されるトラッキングコードに`data-site-id`属性を自動追加：

```html
<!-- 修正前 -->
<script src="tracking.js" async></script>

<!-- 修正後 -->
<script src="tracking.js" data-site-id="site-1-tracking-id" async></script>
```

### 3. **処理済みフラグによる重複実行の防止**
各スクリプトタグに処理済みフラグを設定し、同じスクリプトが複数回処理されることを防止：

```javascript
if (!script.dataset.ciProcessed) {
  script.dataset.ciProcessed = 'true';
  return siteId;
}
```

### 4. **APIエンドポイントの検証強化**
`site_id`の存在と形式を厳密に検証し、エラーメッセージを詳細化：

```javascript
// Validate site_id format
if (typeof event.site_id !== 'string' || event.site_id.trim() === '') {
  console.error('ClickInsight Pro - Invalid site_id format:', event.site_id);
  return NextResponse.json({ 
    error: 'Invalid site_id format: must be a non-empty string',
    site_id: event.site_id
  }, { status: 400 });
}
```

## 修正が本当に機能するか？

### ✅ 修正により解決される問題

1. **各サイトが別々のページにある場合**
   - ✅ `data-site-id`属性により、各ページで正しいサイトIDが使用される
   - ✅ グローバル変数の競合が発生しない

2. **複数のサイトが同じページにある場合**
   - ✅ 処理済みフラグにより、各スクリプトが正しいサイトIDを使用
   - ⚠️ ただし、`async`属性がある場合、スクリプトの実行順序によっては競合する可能性がある

### ⚠️ 残存する潜在的な問題

1. **`async`属性による競合**
   - 複数の`async`スクリプトが同時に実行される場合、処理済みフラグのチェックが競合する可能性がある
   - **推奨解決策**: 各サイトは別々のページに設置する（通常の使用ケース）

2. **スクリプトの読み込み順序**
   - スクリプトの読み込み順序によっては、間違ったサイトIDが使用される可能性がある
   - **現在の実装**: 最後に追加されたスクリプトから順にチェック（逆順）

## テスト方法

1. **各サイトにトラッキングコードを設置**
   ```html
   <!-- サイト1 -->
   <script>
     window.CLICKINSIGHT_SITE_ID = 'site-1-id';
   </script>
   <script src="tracking.js" data-site-id="site-1-id" async></script>
   
   <!-- サイト2 -->
   <script>
     window.CLICKINSIGHT_SITE_ID = 'site-2-id';
   </script>
   <script src="tracking.js" data-site-id="site-2-id" async></script>
   ```

2. **ブラウザのコンソールで確認**
   - デバッグモードを有効化: `window.CLICKINSIGHT_DEBUG = true`
   - 各スクリプトが正しいサイトIDで初期化されているか確認

3. **ネットワークタブで確認**
   - `/api/track`へのリクエストで、正しい`site_id`が送信されているか確認

## 結論

修正により、**各サイトが別々のページにある場合**は確実に動作します。複数のサイトが同じページにある場合は、ほとんどの場合動作しますが、`async`属性による競合の可能性が残っています。

**推奨事項:**
- 各サイトは別々のページに設置する（通常の使用ケース）
- 同じページに複数のトラッキングスクリプトを設置する必要がある場合は、`async`属性を削除するか、各スクリプトに一意のIDを付与する

