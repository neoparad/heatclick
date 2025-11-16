# 複数サイトトラッキング修正 - デプロイガイド

## 変更概要

複数のサイトをトラッキングする際に、1つのサイトしかトラッキングできなかった問題を修正しました。

### 主な変更点

1. **トラッキングスクリプトの改善** (`public/tracking.js`)
   - `data-site-id`属性のサポートを追加
   - `async`属性がある場合でも正しくサイトIDを取得できるように改善
   - デバッグログの追加

2. **トラッキングコード生成の改善**
   - 生成されるスクリプトタグに`data-site-id`属性を自動追加
   - 以下のファイルを更新：
     - `app/sites/page.tsx`
     - `app/settings/page.tsx`
     - `app/api/install/route.ts`

3. **APIエンドポイントの検証強化** (`app/api/track/route.ts`)
   - `site_id`の存在と形式を厳密に検証
   - エラーメッセージを詳細化

## 既存のトラッキングコードについて

### ❌ 既存のコードを削除する必要はありません

**ただし、新しいコードに置き換える必要があります。**

### 既存コードと新コードの違い

**既存のコード（動作するが推奨されない）:**
```html
<!-- UGOKI MAP Tracking -->
<script>
    window.CLICKINSIGHT_SITE_ID = 'your-site-id';
    window.CLICKINSIGHT_DEBUG = false;
    window.CLICKINSIGHT_API_URL = 'https://your-domain.com/api/track';
</script>
<script src="https://your-domain.com/tracking.js" async></script>
<script src="https://your-domain.com/recording.js" async></script>
<!-- End UGOKI MAP -->
```

**新しいコード（推奨）:**
```html
<!-- UGOKI MAP Tracking -->
<script>
    window.CLICKINSIGHT_SITE_ID = 'your-site-id';
    window.CLICKINSIGHT_DEBUG = false;
    window.CLICKINSIGHT_API_URL = 'https://your-domain.com/api/track';
</script>
<script src="https://your-domain.com/tracking.js" data-site-id="your-site-id" async></script>
<script src="https://your-domain.com/recording.js" async></script>
<!-- End UGOKI MAP -->
```

**違い：** `data-site-id="your-site-id"`属性が追加されています。

### 既存コードの更新方法

1. **サイト管理ページから新しいコードを取得**
   - `/sites`ページにアクセス
   - 各サイトの「トラッキングID」ボタンをクリック
   - 表示された新しいトラッキングコードをコピー

2. **既存のコードを新しいコードに置き換え**
   - 各サイトのHTMLの`<head>`セクション内の既存コードを削除
   - 新しいコードを貼り付け

3. **動作確認**
   - ブラウザのコンソールでエラーがないか確認
   - ダッシュボードでデータが正しく表示されるか確認

## デプロイ手順

### 1. コードのデプロイ

```bash
# 変更をコミット
git add .
git commit -m "fix: 複数サイトトラッキング対応の改善"

# デプロイ（Vercelの場合）
git push origin main
```

### 2. デプロイ後の確認

1. **トラッキングスクリプトの確認**
   - `/sites`ページで新しいトラッキングコードを生成
   - `data-site-id`属性が含まれているか確認

2. **動作確認**
   - テストサイトで新しいトラッキングコードを設置
   - ブラウザのコンソールでエラーがないか確認
   - ダッシュボードでデータが正しく表示されるか確認

### 3. 既存サイトへの通知

以下の内容で既存ユーザーに通知することを推奨します：

```
【重要】トラッキングコードの更新について

複数サイトのトラッキング機能を改善しました。
より確実にトラッキングするため、新しいトラッキングコードに更新してください。

更新方法：
1. サイト管理ページ（/sites）にアクセス
2. 各サイトの「トラッキングID」ボタンをクリック
3. 表示された新しいコードをコピー
4. 既存のコードを新しいコードに置き換え

既存のコードも動作しますが、新しいコードの使用を推奨します。
```

## テスト方法

### 1. 単一サイトのテスト

```html
<!-- テストサイト1 -->
<script>
    window.CLICKINSIGHT_SITE_ID = 'test-site-1';
    window.CLICKINSIGHT_DEBUG = true;
</script>
<script src="https://your-domain.com/tracking.js" data-site-id="test-site-1" async></script>
```

**確認項目：**
- コンソールに「ClickInsight Pro: Found site ID from data-site-id attribute: test-site-1」が表示される
- `/api/track`へのリクエストで`site_id: "test-site-1"`が送信される
- ダッシュボードで「test-site-1」のデータが表示される

### 2. 複数サイトのテスト

```html
<!-- テストサイト1 -->
<script>
    window.CLICKINSIGHT_SITE_ID = 'test-site-1';
    window.CLICKINSIGHT_DEBUG = true;
</script>
<script src="https://your-domain.com/tracking.js" data-site-id="test-site-1" async></script>

<!-- テストサイト2 -->
<script>
    window.CLICKINSIGHT_SITE_ID = 'test-site-2';
    window.CLICKINSIGHT_DEBUG = true;
</script>
<script src="https://your-domain.com/tracking.js" data-site-id="test-site-2" async></script>
```

**確認項目：**
- 各サイトで正しいサイトIDが使用される
- 各サイトのデータが個別に表示される

### 3. デバッグモードでの確認

```javascript
// ブラウザのコンソールで
window.CLICKINSIGHT_DEBUG = true;
```

**確認項目：**
- コンソールにサイトIDの取得方法が表示される
- イベント送信時のログが表示される

## ロールバック手順

問題が発生した場合のロールバック手順：

1. **前のバージョンに戻す**
   ```bash
   git revert <commit-hash>
   git push origin main
   ```

2. **既存のトラッキングコードはそのまま使用可能**
   - 既存のコードは後方互換性があるため、そのまま動作します
   - ただし、`data-site-id`属性がない場合は、`window.CLICKINSIGHT_SITE_ID`に依存します

## 変更ファイル一覧

### 修正されたファイル

1. `public/tracking.js`
   - サイトID取得ロジックの改善
   - `data-site-id`属性のサポート追加
   - デバッグログの追加

2. `app/sites/page.tsx`
   - トラッキングコード生成に`data-site-id`属性を追加

3. `app/settings/page.tsx`
   - トラッキングコード生成に`data-site-id`属性を追加

4. `app/api/install/route.ts`
   - WordPress/HTMLコード生成に`data-site-id`属性を追加

5. `app/api/track/route.ts`
   - `site_id`の検証を強化
   - エラーメッセージを詳細化

### 新規作成されたファイル

1. `docs/multi-site-tracking-fix.md`
   - 問題の原因と修正内容の詳細

2. `docs/deployment-multi-site-tracking-fix.md`（このファイル）
   - デプロイガイド

## トラブルシューティング

### 問題：トラッキングが動作しない

**確認項目：**
1. ブラウザのコンソールでエラーを確認
2. ネットワークタブで`/api/track`へのリクエストを確認
3. `data-site-id`属性が正しく設定されているか確認

**解決方法：**
- デバッグモードを有効化：`window.CLICKINSIGHT_DEBUG = true`
- コンソールログを確認して、サイトIDが正しく取得されているか確認

### 問題：複数サイトのデータが混在する

**確認項目：**
1. 各サイトのトラッキングコードに正しい`tracking_id`が設定されているか
2. `data-site-id`属性が正しく設定されているか

**解決方法：**
- 各サイトのトラッキングコードを再生成して、正しい`tracking_id`が設定されているか確認
- 新しいトラッキングコードに更新

## 注意事項

1. **後方互換性**
   - 既存のトラッキングコード（`data-site-id`属性なし）も動作します
   - ただし、新しいコードの使用を推奨します

2. **`async`属性**
   - スクリプトタグに`async`属性がある場合、`document.currentScript`は`null`になります
   - そのため、`data-site-id`属性または`window.CLICKINSIGHT_SITE_ID`が必要です

3. **複数サイトが同じページにある場合**
   - 各スクリプトタグに`data-site-id`属性を設定することで、正しく動作します
   - ただし、通常は各サイトは別々のページにあるため、この問題は発生しません

## サポート

問題が発生した場合：
1. デバッグモードを有効化してログを確認
2. ブラウザのコンソールとネットワークタブを確認
3. 必要に応じて開発チームに連絡

