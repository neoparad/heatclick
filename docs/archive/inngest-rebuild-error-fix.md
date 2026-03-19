# Inngest Rebuild Heatmap Summary エラー修正レポート

**作成日**: 2025年11月14日  
**問題**: 「Rebuild Heatmap Summary (Full)」が100%失敗（2回実行、両方失敗）

---

## 🔍 問題の分析

### エラー状況
- **Runs volume**: 2回
- **Failure rate**: 100.00%
- **問題**: 2回実行されたが、両方とも失敗

### 考えられる原因
1. **エラーハンドリングの不足** - エラーが発生しても詳細なログが出力されない
2. **ClickHouse接続エラー** - 環境変数が正しく設定されていない可能性
3. **クエリのタイムアウト** - 大量データの処理でタイムアウトが発生
4. **メモリ不足** - Vercel Functionsのメモリ制限に引っかかっている可能性

---

## ✅ 実装した修正

### 1. エラーハンドリングの追加

**修正前**:
- エラーハンドリングがなく、エラーが発生しても詳細が分からない
- エラーログが出力されない

**修正後**:
- 各ステップでtry-catchを追加
- 詳細なエラーログを出力（メッセージ、コード、スタックトレース）
- エラーが発生した場合、明確なエラーメッセージをスロー

### 2. ステップ分割による可視性の向上

処理を3つのステップに分割：

1. **check-connection**: ClickHouse接続確認
   - 接続テストを実行
   - 接続エラーを早期に検出

2. **truncate-table**: テーブルクリア
   - 既存データをクリア
   - エラーが発生しても続行（テーブルが存在しない場合など）

3. **rebuild-all-data**: データ集約
   - 処理対象データの情報を取得
   - 集約クエリを実行
   - 結果を確認してログに出力

### 3. 詳細なログ出力

各ステップで以下の情報をログに出力：
- 接続確認の結果
- 処理対象データの範囲（最小日付、最大日付、総イベント数）
- 集約完了後の行数
- エラー発生時の詳細情報

### 4. リトライの無効化

- `retries: 0`を設定
- 手動で再実行する方が安全（自動リトライで問題が悪化する可能性があるため）

---

## 📝 修正内容

### 修正ファイル
- `inngest/funcs/rebuildAll.ts`

### 主な変更点

```typescript
// 修正前: エラーハンドリングなし
export const rebuildAll = inngest.createFunction(
  { id: "rebuild-all-heatmap-summary", name: "Rebuild Heatmap Summary (Full)" },
  { event: "heatmap.rebuild" },
  async ({ event, step }) => {
    return await step.run("rebuild-all-data", async () => {
      // エラーハンドリングなし
      const client = await getClickHouseClientAsync();
      await client.exec({ query: `TRUNCATE TABLE...` });
      await client.query({ query: `INSERT INTO...` });
      return { status: "completed" };
    });
  }
);

// 修正後: エラーハンドリングとステップ分割
export const rebuildAll = inngest.createFunction(
  { 
    id: "rebuild-all-heatmap-summary",
    name: "Rebuild Heatmap Summary (Full)",
    retries: 0, // リトライを無効化
  },
  { event: "heatmap.rebuild" },
  async ({ event, step }) => {
    // ステップ1: 接続確認
    const connectionResult = await step.run("check-connection", async () => {
      try {
        // 接続テストとエラーハンドリング
      } catch (error) {
        // 詳細なエラーログを出力
      }
    });

    // ステップ2: テーブルクリア
    const truncateResult = await step.run("truncate-table", async () => {
      try {
        // テーブルクリアとエラーハンドリング
      } catch (error) {
        // エラーを無視して続行
      }
    });

    // ステップ3: データ集約
    const rebuildResult = await step.run("rebuild-all-data", async () => {
      try {
        // データ範囲の取得
        // 集約クエリの実行
        // 結果の確認
      } catch (error) {
        // 詳細なエラーログを出力
      }
    });

    return { connection: connectionResult, truncate: truncateResult, rebuild: rebuildResult };
  }
);
```

---

## 🔧 次のステップ

### 1. デプロイと再実行

修正をデプロイ後、再度実行：

```bash
curl -X POST https://heatclick-p47dqkc2q-hiroki101313-gmailcoms-projects.vercel.app/api/inngest/rebuild
```

### 2. Inngestダッシュボードで確認

1. **実行履歴を確認**
   - 各ステップの実行状況を確認
   - エラーが発生したステップを特定

2. **エラーログを確認**
   - 各ステップのログを確認
   - エラーメッセージの詳細を確認

3. **接続エラーの場合**
   - 環境変数（`CLICKHOUSE_URL`、`CLICKHOUSE_PASSWORD`など）を確認
   - Vercelの環境変数設定を確認

4. **タイムアウトエラーの場合**
   - データ量が多い可能性
   - 日付ごとにバッチ処理に分割することを検討

---

## 📊 期待される改善

### 修正前
- ❌ エラーが発生しても原因が分からない
- ❌ どのステップで失敗したか分からない
- ❌ エラーログが出力されない

### 修正後
- ✅ 各ステップでエラーハンドリングが実装されている
- ✅ 詳細なエラーログが出力される
- ✅ どのステップで失敗したか明確になる
- ✅ エラーの原因を特定しやすくなる

---

## 🔗 関連ドキュメント

- [Inngestヒートマップセットアップ完了レポート](./inngest-heatmap-setup-completion.md)
- [Inngestセットアップ手順](./inngest-setup-instructions.md)
- [Inngest実装サマリー](./inngest-implementation-summary.md)

---

**最終更新**: 2025年11月14日




