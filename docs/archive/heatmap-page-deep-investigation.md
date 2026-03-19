# ヒートマップページの深層調査レポート

**調査日**: 2025年1月26日  
**目的**: ヒートマップページが表示されない問題の根本原因を特定し、修正

---

## 🔍 発見された問題

### 問題①: APIレスポンスとフロントエンドのインターフェース不一致

**問題の詳細**:
- `/api/sites`エンドポイントは`url`フィールドを返す
- フロントエンドの`Site`インターフェースは`domain`フィールドを期待していた
- これにより、サイト選択ドロップダウンで`site.domain`が`undefined`になり、表示が崩れる可能性があった

**修正内容**:
- ✅ `Site`インターフェースを`url`フィールドを必須、`domain`をオプションに変更
- ✅ サイト選択ドロップダウンで`site.url || site.domain || 'N/A'`を使用するように修正

**影響範囲**:
- サイト選択ドロップダウンの表示
- サイト情報の表示

---

### 問題②: `pages`が空の場合の`selectedPageUrl`のリセット不足

**問題の詳細**:
- サイトを変更した際、新しいサイトにページデータがない場合、`selectedPageUrl`がリセットされず、古いURLが残る
- これにより、存在しないページのヒートマップデータを取得しようとしてエラーが発生する可能性があった

**修正内容**:
- ✅ `selectedSite`が変更された際、`pages`が空の場合は`selectedPageUrl`を空文字列にリセット
- ✅ `selectedSite`が`null`の場合も`selectedPageUrl`をリセット

**影響範囲**:
- サイト切り替え時のページ選択状態
- ヒートマップデータの取得ロジック

---

### 問題③: `heatmap.js`のロード失敗時のエラーハンドリング不足

**問題の詳細**:
- `heatmap.js`がロードに失敗した場合、`h337`が`null`のまま
- ヒートマップデータが存在しても、ライブラリがロードされていないため描画できない
- ユーザーには何が問題なのか分からない状態だった

**修正内容**:
- ✅ `heatmapLoadError`変数を追加し、ロードエラーを追跡
- ✅ `heatmap.js`がロードされていない場合、専用のエラーメッセージを表示
- ✅ リロードボタンを提供して、ユーザーが再試行できるようにした

**影響範囲**:
- ヒートマップライブラリのロード失敗時のユーザー体験
- エラーメッセージの表示

---

### 問題④: エラー発生時のページ表示が保証されていない

**問題の詳細**:
- `sites.length === 0`の場合、早期リターンでページ全体が表示されない
- エラーが発生した場合でも、ページの基本構造が表示されない可能性があった

**修正内容**:
- ✅ `sites.length === 0`の場合の早期リターンを削除
- ✅ サイトが空の場合でも、ページヘッダーとエラーメッセージを表示
- ✅ サイト選択とヒートマップ表示エリアを条件付きレンダリングに変更
- ✅ サイトが空の場合は、専用のカードを表示して「サイトを登録する」リンクを提供

**影響範囲**:
- エラー発生時のページ表示
- サイトが空の場合のユーザー体験

---

## 📊 修正前後の比較

### 修正前の問題点

1. **APIレスポンスの不一致**: `domain`フィールドが存在しないため、サイト情報が正しく表示されない
2. **状態管理の問題**: `selectedPageUrl`が適切にリセットされず、古いデータが残る
3. **エラーハンドリング不足**: `heatmap.js`のロード失敗時に適切なフィードバックがない
4. **ページ表示の保証不足**: エラー時やサイトが空の場合にページが表示されない

### 修正後の改善点

1. ✅ **APIレスポンスの整合性**: `url`フィールドを正しく使用し、後方互換性も確保
2. ✅ **状態管理の改善**: `selectedPageUrl`が適切にリセットされ、一貫性が保たれる
3. ✅ **エラーハンドリングの強化**: `heatmap.js`のロード失敗時に明確なエラーメッセージとリロードオプションを提供
4. ✅ **ページ表示の保証**: エラー時やサイトが空の場合でも、ページの基本構造と適切なメッセージが表示される

---

## 🔧 技術的な変更詳細

### 1. `Site`インターフェースの修正

```typescript
// 修正前
interface Site {
  id: string
  name: string
  domain: string  // APIはurlを返す
  tracking_id: string
  created_at: string
}

// 修正後
interface Site {
  id: string
  name: string
  url: string  // APIはurlを返す
  domain?: string  // 後方互換性のため残す
  tracking_id: string
  created_at: string
}
```

### 2. `pages`取得時の`selectedPageUrl`リセット

```typescript
// 修正前
if (pageList.length > 0) {
  setSelectedPageUrl(pageList[0].url)
}
// ページが空の場合、selectedPageUrlがリセットされない

// 修正後
if (pageList.length > 0) {
  setSelectedPageUrl(pageList[0].url)
} else {
  // ページが空の場合はselectedPageUrlをリセット
  setSelectedPageUrl('')
}
```

### 3. `heatmap.js`のロードエラー追跡

```typescript
// 修正前
let h337: any = null
if (typeof window !== 'undefined') {
  try {
    h337 = require('heatmap.js')
  } catch (error) {
    console.error('Failed to load heatmap.js:', error)
  }
}

// 修正後
let h337: any = null
let heatmapLoadError: Error | null = null

if (typeof window !== 'undefined') {
  try {
    h337 = require('heatmap.js')
    heatmapLoadError = null
  } catch (error) {
    console.error('Failed to load heatmap.js:', error)
    heatmapLoadError = error as Error
  }
}
```

### 4. ページ表示の保証

```typescript
// 修正前
if (sites.length === 0) {
  return (
    <DashboardLayout>
      <div>登録されているサイトがありません</div>
    </DashboardLayout>
  )
}

// 修正後
// 早期リターンを削除し、条件付きレンダリングを使用
{sites.length === 0 && !loading && (
  <Card>
    <CardContent>
      <div>登録されているサイトがありません</div>
      <a href="/sites">サイトを登録する</a>
    </CardContent>
  </Card>
)}

{sites.length > 0 && (
  <Card>
    {/* サイト選択UI */}
  </Card>
)}
```

---

## ✅ 修正後の動作確認項目

1. **サイト選択の表示**: サイトドロップダウンに`url`が正しく表示される
2. **サイト切り替え**: サイトを変更した際、`selectedPageUrl`が適切にリセットされる
3. **ページが空の場合**: ページデータがない場合、適切なメッセージが表示される
4. **heatmap.jsのロード失敗**: ライブラリがロードできない場合、エラーメッセージとリロードボタンが表示される
5. **サイトが空の場合**: サイトが登録されていない場合でも、ページが表示され、登録リンクが提供される
6. **エラー発生時**: エラーが発生しても、ページの基本構造が表示される

---

## 📝 関連ファイル

- `app/heatmap/page.tsx`: ヒートマップページのメインコンポーネント
- `app/api/sites/route.ts`: サイト一覧取得API
- `app/api/pages/route.ts`: ページ一覧取得API
- `app/api/heatmap/route.ts`: ヒートマップデータ取得API

---

## 🎯 今後の改善提案

1. **型安全性の向上**: `Site`インターフェースを共有型定義ファイルに移動し、一貫性を保つ
2. **エラーハンドリングの統一**: エラーメッセージの表示方法を統一コンポーネントで管理
3. **ローディング状態の改善**: 各データ取得のローディング状態を個別に管理
4. **テストの追加**: ヒートマップページの各シナリオに対するユニットテストとE2Eテストを追加

---

**最終更新**: 2025年1月26日

