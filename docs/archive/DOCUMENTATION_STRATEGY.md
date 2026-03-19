# ドキュメント戦略 - AI駆動開発最適化

最終更新: 2025年1月26日

## 📊 現状分析

### 問題点

1. **ドキュメントの重複**
   - `project-status.md` (500行以上)
   - `current-specification.md` (260行)
   - `complete-specification.md` (700行以上)
   - `implementation-summary.md` (690行以上)
   - `specification-for-ai-consultation.md`
   - これらは重複した情報を含んでいる可能性が高い

2. **古い情報の混在**
   - `next-actions.md` に2025年11月の日付が含まれている
   - アーカイブされたファイルが12個存在

3. **AI駆動開発への影響**
   - セマンティック検索のノイズが増える
   - 関連性の低い古いドキュメントが検索結果に混ざる
   - コンテキストウィンドウの無駄遣い
   - 情報の重複や矛盾による混乱
   - メンテナンスコストの増加

## 🎯 推奨されるドキュメント構造

### コアドキュメント（必須・常に最新）

1. **README.md** (プロジェクトルート)
   - プロジェクト概要
   - クイックスタート
   - 主要なリンク

2. **docs/ARCHITECTURE.md**
   - システムアーキテクチャ
   - 技術スタック
   - データフロー

3. **docs/API.md**
   - API仕様
   - エンドポイント一覧
   - リクエスト/レスポンス例

4. **docs/DATABASE.md**
   - データベーススキーマ
   - テーブル定義
   - インデックス戦略

5. **docs/DEVELOPMENT.md**
   - 開発環境セットアップ
   - 開発フロー
   - コーディング規約

### 状況ドキュメント（定期的に更新）

6. **docs/STATUS.md**
   - 現在の開発状況
   - 完了項目
   - 進行中項目
   - 次のアクション（優先度付き）

### 参考ドキュメント（必要に応じて参照）

7. **docs/SPECIFICATIONS.md**
   - 機能仕様
   - 実装計画
   - ロードマップ

8. **docs/INTEGRATIONS.md**
   - 外部API連携
   - セットアップ手順

### アーカイブ（古い情報）

- `docs/archive/` - 過去の実装記録、完了したタスクの記録

## 📋 整理アクションプラン

### Phase 1: 統合（優先度: 高）

1. **統合ドキュメントの作成**
   - `docs/STATUS.md` - `project-status.md` と `next-actions.md` を統合
   - `docs/SPECIFICATIONS.md` - `complete-specification.md`, `current-specification.md`, `specification-for-ai-consultation.md` を統合
   - `docs/IMPLEMENTATION.md` - `implementation-summary.md` を簡潔化

2. **重複ドキュメントのアーカイブ**
   - 統合後、元のファイルを `docs/archive/` に移動

### Phase 2: 整理（優先度: 中）

3. **ドキュメントの分類**
   - コアドキュメント: 常に最新を保つ
   - 参考ドキュメント: 必要に応じて参照
   - アーカイブ: 過去の記録

4. **不要なドキュメントの削除**
   - 完全に古くなった情報は削除
   - または `docs/archive/` に移動

### Phase 3: 最適化（優先度: 低）

5. **ドキュメントの最適化**
   - 各ドキュメントを簡潔に
   - 相互参照を明確に
   - 更新日付を明記

## 🔍 AI駆動開発のベストプラクティス

### 1. シングルソースオブトゥルース
- 各情報は1つのドキュメントにのみ存在
- 重複を避ける

### 2. 明確な構造
- 階層的な構造
- 明確な命名規則

### 3. 定期的な更新
- 古い情報を削除またはアーカイブ
- 更新日付を明記

### 4. 検索性の向上
- 適切な見出し構造
- キーワードの使用
- 相互参照

## 📝 次のステップ

1. [ ] `docs/STATUS.md` の作成（`project-status.md` と `next-actions.md` を統合）
2. [ ] `docs/SPECIFICATIONS.md` の作成（仕様書を統合）
3. [ ] `docs/IMPLEMENTATION.md` の作成（実装サマリーを簡潔化）
4. [ ] 統合後の元ファイルをアーカイブ
5. [ ] README.md の更新（新しいドキュメント構造へのリンク）



