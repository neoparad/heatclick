# UGOKI MAP — 残タスク詳細

**作成日**: 2026-03-20
**最終更新**: 2026-03-20

---

## 1. 構造化ログ（pino導入）

**優先度**: 中 | **見積**: 1日

### 現状
- console.log / console.error が **123箇所** に散在
- 構造化ロギングライブラリ未導入（pinoもwinstonもなし）
- 本番エラーの検索・フィルタリングが不可能

### 影響範囲

| ディレクトリ | console呼び出し数 | 主な用途 |
|---|---|---|
| `lib/redis.ts` | 21 | キャッシュ操作エラー |
| `lib/clickhouse/` | 12 | DB接続・クエリエラー |
| `app/api/` 全ルート | 80 | APIエラーハンドリング |
| その他 | 10 | 初期化・デバッグ |

### 実装内容
1. `npm install pino pino-pretty`
2. `lib/logger.ts` 作成:
   ```typescript
   import pino from 'pino'
   export const logger = pino({
     level: process.env.LOG_LEVEL || 'info',
     transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
   })
   ```
3. 全 `console.error` → `logger.error({ err, context }, 'message')` に置換
4. 全 `console.log` → `logger.info(context, 'message')` に置換
5. 全 `console.warn` → `logger.warn(context, 'message')` に置換

### 期待効果
- JSON構造化ログでVercel Logsの検索が容易に
- エラーにリクエストID・ユーザーID等のコンテキスト付与が可能
- ログレベルで本番のノイズを制御（`LOG_LEVEL=warn`）

---

## 2. gitシークレット履歴浄化

**優先度**: 高 | **見積**: 0.5日 | **状態: ✅ 完了（2026-03-20）**

### 実施結果
- `git filter-branch` で `.env.production`, `.env.vercel`, `.env.local`, `.env.local.backup` を全履歴から除去
- `git reflog expire --expire=now --all && git gc --prune=now --aggressive` で完全パージ
- `git push origin main --force` で反映済み
- 履歴確認: `git log --all --diff-filter=A --name-only -- '.env*'` → 出力なし（完全除去確認）

### 露出していたシークレット
- `NEXTAUTH_SECRET` — joseiのカスタムJWTに移行済みのため実害なし
- `VERCEL_OIDC_TOKEN` — 有効期限付きトークンのため失効済み

### 残: クレデンシャルローテーション（推奨だが緊急度低）
   - ClickHouseパスワード変更（Hetzner 159.69.95.59）
   - Redisパスワード変更
   - PageSpeed APIキー再発行
   - Inngest署名キー再発行
4. **Vercel環境変数を新クレデンシャルで更新**

### リスク
- `git push --force` が必要（チーム開発時は全員にrebase通知）
- 現在は個人開発なのでリスク低

---

## 3. Redis KEYSコマンド → SCAN

**優先度**: 低 | **見積**: 10分 | **状態: ✅ 完了（2026-03-20）**

### 現状
- `lib/redis.ts` L272 の `clearCache()` で `KEYS` コマンドを使用
- `KEYS` は全キーを走査するため、本番Redisでキーが増えると**ブロッキングが発生**

### 修正内容
```typescript
// Before (lib/redis.ts:272)
const keys = await client.keys(pattern)

// After
const keys: string[] = []
let cursor = '0'
do {
  const [nextCursor, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
  cursor = nextCursor
  keys.push(...batch)
} while (cursor !== '0')
```

### 影響ファイル
- `lib/redis.ts` — `clearCache()` 関数のみ

---

## 4. A/Bテスト詳細ページ

**優先度**: 中 | **見積**: 1日

### 現状
- テスト一覧 (`app/tests/page.tsx`, 300行) は実装済み
  - A/B / MVT タブ切替
  - サマリーカード（実行中・完了・平均CVR改善率）
  - テーブル（名前・URL・ステータス・セッション数・CVR比較・信頼度）
- テスト詳細ページ (`app/tests/[id]/page.tsx`) は **未実装**
- API (`app/api/tests/[id]/route.ts`) はGET/PUT/DELETE実装済み
- モック: `mock-ab-mvt-test.html` にUI設計書あり

### 実装内容

**新規ファイル**: `app/tests/[id]/page.tsx`

| セクション | 内容 |
|---|---|
| ヘッダー | テスト名・ステータス・作成日・開始/停止ボタン |
| KPIカード | セッション数A/B・CVR A/B・改善率・統計的有意差 |
| ヒートマップ比較 | A/Bページを横並び表示（クリック/スクロール/熟読タブ切替） |
| 時系列グラフ | CVR推移（recharts LineChart） |
| 詳細テーブル | 要素別クリック数の比較 |

### 依存
- `/api/tests/[id]` GET — 既存で使用可
- `/api/heatmap` — 既存で使用可（page_url_a / page_url_b それぞれで呼び出し）

---

## 5. AI診断（Claude API統合）

**優先度**: 高 | **見積**: 2日 | **差別化の核心機能**

### 現状
- Claude APIキー: `.env.local` に設定済み（`CLAUDE_API_KEY`）
- AI分析ページ (`app/ai-insights/page.tsx`, 379行): **UIはモックデータで実装済み**
  - 12個のインサイト表示
  - 優先度バッジ（緊急/重要/SEO）
  - 現状→目標のメトリクス比較
  - 改善提案の表示
  - 実装コードの表示
- 分析軸: `lib/analysis-axes.ts` に **40軸すべてに `aiPromptHint` 付き**
  - 各軸にClaude向けの具体的な分析指示テキスト（日本語）
  - 例: 「CVに寄与している要素と、寄与していない要素を比較し、CTAの改善提案を出してください」
- MCP Server: `mcp-server.ts` に7ツール実装済み

### 実装内容

**Phase 1: API実装** (`app/api/ai-diagnosis/route.ts`)
```
1. サイトの20軸分析データを取得（executeAllAxes）
2. 分析データ + aiPromptHint をClaudeに送信
3. Claudeの応答をパース（改善提案・優先度・予想インパクト）
4. 結果をキャッシュ（Redis, TTL 24h）
```

**Phase 2: UI接続** (`app/ai-insights/page.tsx`)
```
1. モックデータ → /api/ai-diagnosis からのリアルデータに切替
2. 「再分析」ボタン → APIコール
3. ローディング状態（分析に30-60秒かかる）
4. 結果の保存・履歴表示
```

**Phase 3: Inngest非同期ジョブ**（オプション）
```
1. 分析リクエスト → Inngestジョブとしてキュー
2. 完了時にRedis Pub/Subで通知
3. ダッシュボードでリアルタイム結果表示
```

### Claude APIコスト見積
- 20軸の分析データ: 約50-100KB
- Claude応答: 約5-10KB
- 1回の分析: 約$0.05-0.10（Sonnet 4）
- 月間100回分析: 約$5-10

### 依存
- `CLAUDE_API_KEY` 環境変数（設定済み）
- `lib/analysis-axes.ts` の `executeAllAxes()` — 実装済み
- Anthropic SDK（`npm install @anthropic-ai/sdk`）

---

## 6. 本番デプロイ準備

**優先度**: 高 | **見積**: 0.5日

### 現状
- Vercelプロジェクト: `heatclick-ai` (prj_8fh4NHAWEdcudWbBQJFALSnwAomE)
- カスタムドメイン: 未設定
- `vercel.json`: API・ヒートマップページのキャッシュ無効化設定済み
- 本番環境変数: ClickHouse/Redis/Sentry設定済み

### チェックリスト

| # | 項目 | 状態 |
|---|---|---|
| 1 | Vercel環境変数の確認（全キー設定済みか） | 要確認 |
| 2 | カスタムドメイン設定（ugokimap.com等） | 未実施 |
| 3 | ClickHouse本番接続の疎通確認 | 要確認 |
| 4 | Redis本番接続の疎通確認 | 要確認 |
| 5 | Sentry DSN設定 | ✅ 完了 |
| 6 | トラッキングスクリプトのCDN配信 | 未実施 |
| 7 | `/api/health` の外部監視設定 | 未実施 |
| 8 | `reports/page.tsx` のTODOコメント2件 | 未実施 |

### TODO/FIXMEコメント（コードベース内）
- `app/reports/page.tsx`: `// TODO: 実際のレポート生成APIを実装`
- `app/reports/page.tsx`: `// TODO: レポートプレビュー機能の実装`
- 他のTODO/FIXME: なし

---

## 完了済みタスク（本セッション）

| # | タスク | 完了日 |
|---|--------|--------|
| 2 | gitシークレット履歴浄化（filter-branch + force push） | 2026-03-20 |
| 3 | Redis KEYS → SCAN修正 | 2026-03-20 |
| — | Sentry導入（@sentry/nextjs + instrumentation.ts + Vercel DSN設定 + 動作確認済み） | 2026-03-20 |

## 推奨実行順序（残タスク）

```
[最優先] #5 AI診断（差別化の核）
   ↓
[中期]  #1 構造化ログ → #4 A/Bテスト詳細
   ↓
[リリース] #6 本番デプロイ
```

**最優先は #5 AI診断**。これがUGOKI MAPの最大の差別化ポイントであり、比較ドキュメントの「AI自動診断」クレームを実現する機能。データ基盤（40軸 + aiPromptHint）は完成しているので、Claude APIとの接続 + UIの実データ化で完成する。
