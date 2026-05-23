# CLAUDE.md — ugokimap-saas 開発指示

このファイルは Claude Code がこのプロジェクトで作業する際の指針。

## プロジェクト概要

**UGOKI MAP / LINKTH 統合 SaaS**。Next.js 14 + Tailwind + shadcn/ui + Stripe + Anthropic SDK + ClickHouse + Workers。

- **Single Source of Truth**: `C:\Users\M2603\linkscrawl\docs\fusion\strategy\19_grand_v1.md`
- **再開ガイド**: `C:\Users\M2603\linkscrawl\docs\fusion\team\PARALLEL_STREAMS.md`
- **ロール別プロンプト**: `C:\Users\M2603\linkscrawl\docs\fusion\team\RESUME_PROMPTS.md`

## 絶対ルール

1. **旧 ugokimap (`C:\Users\M2603\ugokimap\`) の `app/*` には触らない** (D-01)
2. **既存 mini-saas の Vercel デプロイを壊さない** (D-03)
3. **§1.7 Anti-Features 違反コードを書かない** (特に §1.7.1 — A/B execution は VWO 委譲)
4. **AI 出力には Evidence Level バッジ必須** (§1.6 原則 2 / §1.8.2 / D-07)
5. **secrets は `.env.local` のみ、git にコミットしない** (`.gitignore` 厳守)
6. **`reference/components/` 系の SSOT モックを修正する前にオーナー承認** (mini-saas/CLAUDE.md 整合)
7. **tenant_id を全 DB 操作・API call で必ず保持・検証** (§3.8.1 multi-tenant isolation)

## デプロイ

- **本番**: Vercel (オーナー既契約、`ugokimap.com` ドメイン)
- **Preview**: PR ごとに自動デプロイ
- **worktree からデプロイ禁止** (mini-saas/CLAUDE.md ルール継承)

## コード規約

### TypeScript
- 厳格モード (`strict: true`)
- `any` 禁止、`unknown` + narrowing で対応
- 公開 API には明示的な型 + 戻り値型
- Zod でランタイム検証 (API 境界 + 環境変数)

### React
- Server Components 優先、Client Components は `'use client'` 明示時のみ
- `React.FC` 使わない
- props は `interface ComponentNameProps`

### Naming
- ファイル: kebab-case (`auth-utils.ts`)、または PascalCase (`HeatmapCanvas.tsx`)
- 関数: camelCase
- 定数: SCREAMING_SNAKE_CASE
- React コンポーネント: PascalCase

### Imports
- Absolute imports (`@/lib/auth` を `tsconfig.json` の paths で設定)
- 並び順: external → internal absolute → internal relative

### Error Handling
- async/await + try-catch
- エラーは Sentry + 構造化ログ (pino) に送る
- ユーザー向けエラーメッセージは PII を含めない

### Tenant Isolation
すべての API route / DB query で:
1. JWT から `tenant_id` 抽出 (`lib/tenant.ts`)
2. ClickHouse query に `WHERE tenant_id = {tenant_id}` 必須
3. cross-tenant アクセス試行は 403 で拒否 + audit_events に記録
4. middleware で全 `/api/*` 経由を強制チェック

### Evidence Level
AI / ML が出力する全 insight に必須:
- `evidence_level: 'proven' | 'observed' | 'inferred' | 'planned'`
- `evidence_data`: 根拠データへの参照配列
- `confidence: number` (0-1)
- UI で `inferred` / `planned` の場合は「推定 X CV/月」断定数値表示禁止 (D-07)

## テスト

### Unit
- Jest + Testing Library
- `app/`, `lib/`, `components/` 配下のロジック

### E2E
- Playwright
- Critical user flows: sign-in / dashboard / heatmap / billing / delete-request

### Coverage
- 80%+ 目標 (親 SSOT §2.3)
- Sprint 5 までに達成

## Codex dual review

T1 (Critical) — Claude + Codex dual review 必須:
- 認証 / Stripe webhook / tenant isolation / 削除 API / migration SQL
- LLM プロンプト変更 / ML パイプライン

T2 (Normal) — Claude 単独、自信度 < 8/10 のみ Codex 委譲

T3 (Trivial) — Codex 単独可 (typo / format / unused import)

詳細: 親 `team/reviewer.md` 参照。

## Sprint 0 の現在地

`README.md` のタスク表参照。

開始する前にチェック:
1. 親 SSOT `19_grand_v1.md` の §6.3 Sprint 0 を読む
2. このプロジェクトの `README.md` の「ステータス」確認
3. `migrations/2026-05-17-sprint0-tenant-isolation.sql` を Infrastructure Engineer に渡す準備

## 緊急時

- tenant cross-access 検出 → 即 Director + Reviewer
- Stripe 誤課金 → 即 CFO + Director
- ClickHouse 破壊 → 即 Infrastructure Engineer
- secret 漏洩疑い → 即停止 + 親 `decisions.md` に記録 + secret rotation
