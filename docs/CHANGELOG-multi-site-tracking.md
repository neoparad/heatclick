# 変更履歴 - 複数サイトトラッキング修正

## [2024-XX-XX] 複数サイトトラッキング対応の改善

### 🐛 修正
- 複数のサイトを登録しても、1つのサイトしかトラッキングできなかった問題を修正
- `async`属性がある場合でも正しくサイトIDを取得できるように改善

### ✨ 新機能
- トラッキングスクリプトタグに`data-site-id`属性を自動追加
- デバッグログの追加（`window.CLICKINSIGHT_DEBUG = true`で有効化）

### 🔧 改善
- APIエンドポイントでの`site_id`検証を強化
- エラーメッセージを詳細化

### 📝 変更ファイル
- `public/tracking.js` - サイトID取得ロジックの改善
- `app/sites/page.tsx` - トラッキングコード生成の改善
- `app/settings/page.tsx` - トラッキングコード生成の改善
- `app/api/install/route.ts` - インストールコード生成の改善
- `app/api/track/route.ts` - 検証ロジックの強化

### ⚠️ 破壊的変更
なし（後方互換性あり）

### 📋 移行ガイド
既存のトラッキングコードは動作しますが、新しいコードへの更新を推奨します。
詳細は `docs/deployment-multi-site-tracking-fix.md` を参照してください。

